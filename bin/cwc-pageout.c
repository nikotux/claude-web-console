#define _GNU_SOURCE

/* bin/cwc-pageout.c — desaloja páginas anónimas privadas de un proceso propio. */
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <unistd.h>
#include <linux/mman.h>

#define MAX_BATCH_IOVECS 1024

static void usage(const char *program)
{
    fprintf(stderr, "uso: %s <pid> [--cold]\n", program);
}

static int process_gone_errno(int error)
{
    return error == ESRCH || error == ENOENT;
}

static int append_range(struct iovec **ranges, size_t *count, size_t *capacity,
                        unsigned long start, unsigned long end)
{
    struct iovec *grown;
    size_t next_capacity;

    if (end <= start)
        return 0;
    if (*count == *capacity) {
        next_capacity = *capacity == 0 ? 64 : *capacity * 2;
        if (next_capacity < *capacity || next_capacity > SIZE_MAX / sizeof(**ranges)) {
            errno = ENOMEM;
            return -1;
        }
        grown = realloc(*ranges, next_capacity * sizeof(**ranges));
        if (grown == NULL)
            return -1;
        *ranges = grown;
        *capacity = next_capacity;
    }

    (*ranges)[*count].iov_base = (void *)start;
    (*ranges)[*count].iov_len = (size_t)(end - start);
    *count += 1;
    return 0;
}

int main(int argc, char **argv)
{
    char *pid_end = NULL;
    long parsed_pid;
    pid_t pid;
    int advice = MADV_PAGEOUT;
    const char *advice_name = "pageout";
    char proc_dir[64];
    char maps_path[80];
    struct stat proc_stat;
    FILE *maps = NULL;
    char *line = NULL;
    size_t line_capacity = 0;
    struct iovec *ranges = NULL;
    size_t range_count = 0;
    size_t range_capacity = 0;
    int pidfd = -1;
    unsigned long long bytes_advised = 0;
    size_t batches_failed = 0;
    int saw_esrch = 0;
    int exit_code = 0;

    if (argc < 2 || argc > 3 || (argc == 3 && strcmp(argv[2], "--cold") != 0)) {
        usage(argv[0]);
        return 1;
    }
    if (argc == 3) {
        advice = MADV_COLD;
        advice_name = "cold";
    }

    errno = 0;
    parsed_pid = strtol(argv[1], &pid_end, 10);
    if (errno != 0 || pid_end == argv[1] || *pid_end != '\0'
        || parsed_pid <= 0 || parsed_pid > INT_MAX) {
        usage(argv[0]);
        return 1;
    }
    pid = (pid_t)parsed_pid;

    snprintf(proc_dir, sizeof(proc_dir), "/proc/%ld", (long)pid);
    if (stat(proc_dir, &proc_stat) != 0) {
        int error = errno;
        fprintf(stderr, "no se pudo inspeccionar pid %ld: %s\n",
                (long)pid, strerror(error));
        return process_gone_errno(error) ? 3 : 1;
    }

    /* Guarda obligatoria: jamás aconsejar memoria de procesos de otro usuario. */
    if (proc_stat.st_uid != getuid()) {
        fprintf(stderr, "pid no pertenece al usuario actual\n");
        return 2;
    }

    snprintf(maps_path, sizeof(maps_path), "/proc/%ld/maps", (long)pid);
    maps = fopen(maps_path, "r");
    if (maps == NULL) {
        int error = errno;
        fprintf(stderr, "no se pudo abrir %s: %s\n", maps_path, strerror(error));
        return process_gone_errno(error) ? 3 : 1;
    }

    while (getline(&line, &line_capacity, maps) >= 0) {
        unsigned long start;
        unsigned long end;
        unsigned long long offset;
        unsigned long long inode;
        char perms[5] = {0};
        char dev[32] = {0};
        int consumed = 0;
        char *pathname;
        char *tail;

        if (sscanf(line, "%lx-%lx %4s %llx %31s %llu %n",
                   &start, &end, perms, &offset, dev, &inode, &consumed) != 6) {
            continue;
        }

        pathname = line + consumed;
        while (*pathname == ' ' || *pathname == '\t')
            pathname += 1;
        tail = pathname + strlen(pathname);
        while (tail > pathname && (tail[-1] == '\n' || tail[-1] == '\r'
                                   || tail[-1] == ' ' || tail[-1] == '\t')) {
            *--tail = '\0';
        }

        /* Solo privados y anónimos (pathname vacío) o el heap exacto.
         * Esto excluye explícitamente stack/vdso/vvar/vsyscall, compartidos y
         * todo mapeo respaldado por un archivo cuyo pathname empieza con '/'. */
        if (strlen(perms) != 4 || perms[3] != 'p')
            continue;
        if (strcmp(pathname, "[stack]") == 0
            || strcmp(pathname, "[vdso]") == 0
            || strcmp(pathname, "[vvar]") == 0
            || strcmp(pathname, "[vsyscall]") == 0
            || pathname[0] == '/') {
            continue;
        }
        if (pathname[0] != '\0' && strcmp(pathname, "[heap]") != 0)
            continue;
        if (append_range(&ranges, &range_count, &range_capacity, start, end) != 0) {
            fprintf(stderr, "no se pudo reservar memoria para los rangos: %s\n",
                    strerror(errno));
            fclose(maps);
            free(line);
            free(ranges);
            return 1;
        }
    }

    if (ferror(maps)) {
        int error = errno != 0 ? errno : EIO;
        fprintf(stderr, "falló la lectura de %s: %s\n", maps_path, strerror(error));
        fclose(maps);
        free(line);
        free(ranges);
        return process_gone_errno(error) ? 3 : 1;
    }
    fclose(maps);
    free(line);

    pidfd = (int)syscall(SYS_pidfd_open, pid, 0);
    if (pidfd < 0) {
        int error = errno;
        fprintf(stderr, "pidfd_open(%ld) falló: %s\n", (long)pid, strerror(error));
        free(ranges);
        return error == ESRCH ? 3 : 1;
    }

    for (size_t first = 0; first < range_count; first += MAX_BATCH_IOVECS) {
        size_t batch_count = range_count - first;
        ssize_t advised;

        if (batch_count > MAX_BATCH_IOVECS)
            batch_count = MAX_BATCH_IOVECS;
        advised = syscall(SYS_process_madvise, pidfd, ranges + first,
                          batch_count, advice, 0);
        if (advised < 0) {
            int error = errno;
            batches_failed += 1;
            fprintf(stderr, "process_madvise(%ld), tanda %zu, falló: %s\n",
                    (long)pid, first / MAX_BATCH_IOVECS + 1, strerror(error));
            if (error == ESRCH)
                saw_esrch = 1;
            continue;
        }
        bytes_advised += (unsigned long long)advised;
    }

    close(pidfd);
    free(ranges);

    printf("{\"pid\":%ld,\"ranges\":%zu,\"bytes_advised\":%llu,"
           "\"batches_failed\":%zu,\"advice\":\"%s\"}\n",
           (long)pid, range_count, bytes_advised, batches_failed, advice_name);

    if (saw_esrch)
        exit_code = 3;
    else if (batches_failed > 0)
        exit_code = 1;
    return exit_code;
}
