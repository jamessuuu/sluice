# Font sources and licence verification

All three typefaces are OFL 1.1 (SIL Open Font License). Verified against the
copyright/licence file shipped with the upstream source in every case (copied
alongside this notice as `LICENSE-<Family>.txt`) — not assumed from a name.

| Family | Upstream source | Version fetched | Licence file | Verified |
|---|---|---|---|---|
| Archivo | `github.com/google/fonts` `ofl/archivo/Archivo[wdth,wght].ttf` | Google Fonts main branch, fetched 2026-09-06 | `LICENSE-Archivo.txt` (`OFL.txt` from the same directory) | OFL 1.1, "Copyright 2020 The Archivo Project Authors" |
| Instrument Serif | `github.com/google/fonts` `ofl/instrumentserif/InstrumentSerif-{Regular,Italic}.ttf` | Google Fonts main branch, fetched 2026-09-06 | `LICENSE-InstrumentSerif.txt` | OFL 1.1, "Copyright 2024 The Instrument Serif Project Authors" |
| Commit Mono | `github.com/eigilnikolajsen/commit-mono` release `v1.143` | `CommitMono-1.143.zip`, fetched 2026-09-06 | `LICENSE-CommitMono.txt` (`license.txt` from the release zip) + `github.com/eigilnikolajsen/commit-mono/blob/main/LICENSE-FONT` (copyright line) | OFL 1.1, "Copyright (c) 2023 Eigil Nikolajsen (eigi0088@gmail.com)" |

Source URLs actually fetched (curl, 2026-09-06):

- `https://raw.githubusercontent.com/google/fonts/main/ofl/archivo/Archivo%5Bwdth,wght%5D.ttf`
- `https://raw.githubusercontent.com/google/fonts/main/ofl/archivo/OFL.txt`
- `https://raw.githubusercontent.com/google/fonts/main/ofl/instrumentserif/InstrumentSerif-Regular.ttf`
- `https://raw.githubusercontent.com/google/fonts/main/ofl/instrumentserif/InstrumentSerif-Italic.ttf`
- `https://raw.githubusercontent.com/google/fonts/main/ofl/instrumentserif/OFL.txt`
- `https://github.com/eigilnikolajsen/commit-mono/releases/download/v1.143/CommitMono-1.143.zip`
- `https://raw.githubusercontent.com/eigilnikolajsen/commit-mono/main/LICENSE-FONT`

No paid assets. No font foundry account used. Zero stock/paid fonts anywhere in this
package.

## Commit Mono: one honest deviation from the DNA brief, done in the open

The DNA brief calls for "Commit Mono (variable)". **No official variable release of
Commit Mono exists.** The v1.143 release (like every release checked back to 1.132)
ships four static instances only: Regular (400), Italic (400), Bold (700), Bold
Italic (700). This is a fact about the upstream project, not a choice made here —
confirmed by listing every GitHub release asset for the repository, all named
`CommitMono-<version>.zip` containing the same four static files, and by the
project's own `installation.txt`, which describes exactly those four files as "a
Style Group."

Rather than silently ship a static font under a "(variable)" label, or invent a
name, this package **builds a real 2-master variable font** from the official
Regular (400) and Bold (700) statics:

1. Both masters were subset to the Google Fonts "latin" range (see `substrate.css`'s
   `unicode-range`).
2. Glyph-order and contour-count compatibility was checked programmatically after
   subsetting: **0 mismatches across 856 glyphs** (18 glyphs mismatch in the full,
   unsubsetted font — all outside the latin subset: rare accented glyphs and
   stylistic-set alternates not needed here).
3. `fonttools varLib` merged the two compatible masters over a `wght 400-700`
   designspace, producing a genuine `fvar`/`gvar` variable font (verified: `fvar`
   reports axis `wght 400.0 400.0 700.0`; `gvar` present; 856 glyphs).
4. A handful of stylistic-set and contextual-kerning alternate glyphs (`g.leftL`,
   `i.cv04`, etc. — OpenType feature variants, not base letterforms) were skipped by
   varLib as incompatible between masters and are absent from this build. Base
   rendering is unaffected; `calt`/`kern`/`liga`/`tnum` are retained.

This is a **Modified Version** under OFL 1.1 permission 2 (bundling/redistributing
modified copies is explicitly permitted, provided the copyright notice and licence
travel with it — both do, in `LICENSE-CommitMono.txt` and in the font's own `name`
table ID 0). No Reserved Font Name is declared anywhere in the upstream licence
file or the `LICENSE-FONT` copyright header, so the family name "Commit Mono" is not
legally reserved — the `name` table nonetheless carries a version string
(`variable-build:fonttools-varLib`) and an extended copyright notice disclosing the
derivation, so nobody downstream mistakes this for an official release.

**If this deviation is unacceptable, the fallback is trivial**: ship the two
official static weights (400, 700) as two separate `@font-face` blocks with
overlapping `font-weight` ranges (`font-weight: 400 500` / `font-weight: 600 700`)
instead of one variable file. That was the fallback plan; the variable build was
attempted first, verified compatible, and used because it actually delivers weight
500 (used by `--text-micro` and `--text-readout`) rather than rounding it to the
nearest static.
