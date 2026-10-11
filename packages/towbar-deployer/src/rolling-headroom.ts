export const rollingMemoryHeadroomScript = String.raw`set -euo pipefail
memory="$1"
surge="$2"
required_memory="$(python3 - "$memory" "$surge" <<'PYTHON'
import re, sys
value = sys.argv[1].lower()
match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)([kmgt]i?b?|b)", value)
if not match:
    raise SystemExit("Invalid memory limit")
amount = float(match.group(1))
unit = match.group(2)
powers = {"b": 0, "k": 1, "kb": 1, "kib": 1, "m": 2, "mb": 2, "mib": 2, "g": 3, "gb": 3, "gib": 3, "t": 4, "tb": 4, "tib": 4}
print(int(amount * (1024 ** powers[unit]) * int(sys.argv[2])))
PYTHON
)"
available_memory="$(( $(awk '/MemAvailable:/ {print $2}' /proc/meminfo) * 1024 ))"
test "$available_memory" -ge "$required_memory" || {
  echo "Insufficient memory headroom for the declared rolling surge" >&2
  exit 75
}
`;
