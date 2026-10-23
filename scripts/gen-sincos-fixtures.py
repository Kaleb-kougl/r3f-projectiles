#!/usr/bin/env python3
"""Generate src/__tests__/fixtures/sincos.json: correctly rounded sin / cos.

The reference for `src/detmath.ts`' accuracy test (docs/detmath-plan.md,
"Proving it" item 1). Run once offline and commit the output; CI never runs it:

    python3 scripts/gen-sincos-fixtures.py

Requires mpmath. Every value is computed at 200 bits from the exact input
double, then rounded once to the nearest double (ties to even, subnormals
included). The reference is independent of any JS engine and of fdlibm, which
is what lets the test catch a port bug that is still deterministic.

Encoding: every double (x, sin, cos) is stored as the 16-hex-digit big-endian
IEEE 754 bit pattern of the double, e.g. 1.0 -> "3ff0000000000000". That is
exact by construction (no decimal round trip) and keeps the sign of zero. The
test decodes with a DataView. A readable `xd` (Python repr of x, informational
only) rides along.

Inputs are deterministic (a fixed seed), de-duplicated by bit pattern, and
sorted by value, so re-running the script reproduces the file byte for byte.
"""

import json
import math
import os
import random
import struct

import mpmath
from mpmath import mp, mpf
from mpmath.libmp import libmpf

mp.prec = 200

# 2^19 * pi/2 = 2^18 * pi: the documented accuracy range of detmath.ts.
# Scaling by a power of two is exact, so this is also the double nearest to
# the real 2^18 * pi.
DETMATH_RANGE = 2.0**18 * math.pi
assert struct.pack(">d", DETMATH_RANGE).hex() == "412921fb54442d18"

TAU = math.pi * 2  # as JS computes `Math.PI * 2`


def bits(x: float) -> str:
    return struct.pack(">d", x).hex()


def to_double(v: mpf) -> float:
    """Round a high-precision mpf to the nearest double, ties to even."""
    if v == 0:
        return 0.0
    if abs(v) < mpf(2) ** -1022:
        # Subnormal: round to a multiple of 2^-1074 in one step (to_float would
        # round to 53 bits first and then again in ldexp: double rounding).
        n = int(mpmath.nint(v * mpf(2) ** 1074))  # nint: ties to even
        return math.ldexp(n, -1074)
    sign, man, exp, bc = libmpf.normalize(*v._mpf_, 53, "n")
    out = math.ldexp(man, exp)
    return -out if sign else out


def nearest_double(v: mpf) -> float:
    return to_double(v)


def neighbours(x: float, k: int):
    """x and its +-1..k ulp neighbours."""
    out = [x]
    up = down = x
    for _ in range(k):
        up = math.nextafter(up, math.inf)
        down = math.nextafter(down, -math.inf)
        out += [up, down]
    return out


inputs: list[float] = [0.0, -0.0]

# +-k*pi/2, k = 1..64 (the double nearest the real multiple), +-1, +-2 ulp.
for k in range(1, 65):
    x = nearest_double(mpf(k) * mp.pi / 2)
    for y in neighbours(x, 2):
        inputs += [y, -y]

# Large multiples of pi/2 up to the range limit: the reduction's hardest
# cancellations, which need fdlibm's second and third refinement rounds.
big_ks = [2**j for j in range(7, 19)] + [2**j - 1 for j in range(7, 19)]
rng_k = random.Random(1993)
big_ks += [rng_k.randrange(65, 2**19) for _ in range(60)]
for k in sorted(set(big_ks)):
    x = nearest_double(mpf(k) * mp.pi / 2)
    for y in neighbours(x, 1):
        inputs += [y, -y]

# Tiny values: the fast paths' thresholds (2^-27, 2^-26) and their
# neighbours, the smallest normal and subnormal, 1e-300.
tiny = [1e-300, 5e-324, 2.0**-1022, 2.0**-1074 * 3, 1e-20, 1e-10, 1e-8]
tiny += neighbours(2.0**-27, 2)
tiny += neighbours(2.0**-26, 1)
tiny += neighbours(2.0**-27 * math.sqrt(2), 1)
for t in tiny:
    inputs += [t, -t]

# The kernels' internal thresholds: |x| = 0.3, 0.78125, pi/4.
for t in [0.3, 0.78125, math.pi / 4, 0.75, 0.5]:
    for y in neighbours(t, 2):
        inputs += [y, -y]

# Every ring angle the game uses: (i / count) * TAU in double, count 1..64.
for count in range(1, 65):
    for i in range(count):
        inputs.append((i / count) * TAU)

# Arc angles: (i / (count - 1) - 0.5) * spread, a few spreads.
spreads = [0.25, 0.5, 1.0, math.pi / 6, math.pi / 4, math.pi / 3, math.pi / 2, math.pi, TAU]
for spread in spreads:
    for count in range(2, 17):
        for i in range(count):
            inputs.append((i / (count - 1) - 0.5) * spread)

# A uniform sweep in [-1e5, 1e5].
rng = random.Random(20261023)
for _ in range(500):
    inputs.append(rng.uniform(-1e5, 1e5))

# A uniform sweep over the angles a game actually uses, [-8, 8].
for _ in range(300):
    inputs.append(rng.uniform(-8.0, 8.0))

# A log sweep from 1e-8 up to the range limit, both signs.
lo, hi = math.log(1e-8), math.log(DETMATH_RANGE)
for i in range(400):
    x = math.exp(lo + (hi - lo) * (i + rng.random()) / 400)
    x = min(x, DETMATH_RANGE)
    inputs += [x, -x]

# Just under (and at) the range limit.
for y in neighbours(DETMATH_RANGE, 0) + [
    math.nextafter(DETMATH_RANGE, 0),
    DETMATH_RANGE - 1e-6,
    DETMATH_RANGE - 0.5,
    DETMATH_RANGE - 1,
    DETMATH_RANGE - 10,
    DETMATH_RANGE - 1000,
]:
    inputs += [y, -y]
for _ in range(40):
    y = rng.uniform(DETMATH_RANGE - 100, DETMATH_RANGE)
    inputs += [y, -y]

# De-duplicate by bit pattern (keeps -0 apart from 0), sort by value.
seen: dict[str, float] = {}
for x in inputs:
    assert math.isfinite(x) and abs(x) <= DETMATH_RANGE, x
    seen.setdefault(bits(x), x)
xs = sorted(seen.values(), key=lambda v: (v, math.copysign(1, v)))

entries = []
for x in xs:
    if x == 0:
        s, c = x, 1.0  # sin(+-0) = +-0 exactly; mpf has no signed zero
    else:
        m = mpf(x)  # exact
        s, c = to_double(mpmath.sin(m)), to_double(mpmath.cos(m))
    entries.append({"x": bits(x), "sin": bits(s), "cos": bits(c), "xd": repr(x)})

out = {
    "description": (
        "Correctly rounded sin/cos of each x, from mpmath at 200 bits "
        "(scripts/gen-sincos-fixtures.py). x, sin and cos are the 16-hex-digit "
        "big-endian IEEE 754 bit patterns of the doubles; xd is repr(x), "
        "informational only."
    ),
    "count": len(entries),
    "entries": entries,
}

path = os.path.join(os.path.dirname(__file__), "..", "src", "__tests__", "fixtures", "sincos.json")
os.makedirs(os.path.dirname(path), exist_ok=True)
# One entry per line, so a diff of a regenerated file is readable.
with open(path, "w") as f:
    head = {k: v for k, v in out.items() if k != "entries"}
    f.write(json.dumps(head)[:-1] + ', "entries": [\n')
    f.write(",\n".join(json.dumps(e) for e in entries))
    f.write("\n]}\n")
print(f"wrote {len(entries)} entries to {os.path.normpath(path)}")
