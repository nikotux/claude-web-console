#!/usr/bin/env bash
# Compila el helper que puede recibir CAP_SYS_NICE como binario ELF.
set -euo pipefail

cd "$(dirname "$0")/.."
gcc -O2 -Wall -Wextra -o bin/cwc-pageout bin/cwc-pageout.c

echo "Compilación completa. Ejecutá una única vez:"
echo "sudo setcap cap_sys_nice+ep /home/nmosquera/claude-web-console/bin/cwc-pageout"
echo "Sin esa capability, el binario falla con EPERM al aconsejar memoria de otro proceso."
