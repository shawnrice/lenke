# ISO/IEC 39075 (GQL) — free digital artifacts

ISO publishes six machine-readable "electronic inserts" for 39075 at no charge. They answer more
than the grammar does, and they are the first place to look for any conformance question.

**Directory:** <https://standards.iso.org/iso-iec/39075/ed-1/en/>

## Why these files are not in the repo

They are **not** vendored here, and must not be. Two independent reasons:

1. **The licence is a grant to USE, not to republish.** ISO's statement on the standards portal:

   > You are permitted to use the electronic insert(s) available on this site, in their original
   > format without any modifications for the purposes specified in their respective ISO
   > standard(s). When you download any electronic insert, you accept the ISO Customer Licence
   > Agreement ("Licence Agreement"), clauses 1. ISO's Copyright, 7. Termination, 8. Limitations,
   > and 9. Governing Law.

   Nothing there grants redistribution, and the permission is conditioned on "without any
   modifications" — so transcribing them into markdown is no better than copying the files.
   Free to download is not free to redistribute. Questions: <copyright@iso.org>.

2. **The repo already forbids it.** `CLAUDE.md`, on the authoritative grammars: "We implement these
   languages independently and lower them to our own IR — we do **not** copy grammar text, vendor
   code, or 'features' into this repo. These are read-only references for checking that our surface
   syntax is faithful; nothing from them is vendored here."

So `fetch.sh` downloads them on demand into `artifacts/`, which is gitignored. Only this README and
the script are committed.

```sh
research/iso-39075/fetch.sh   # download into ./artifacts/
```

## What each artifact answers

| file                                             | contents                                                  |
| ------------------------------------------------ | --------------------------------------------------------- |
| `ISO_IEC_39075(en).bnf.txt`                      | the grammar, `<GQL-program>` downward (~77 KB)            |
| `ISO_IEC_39075(en).bnf.xml`                      | the same grammar, machine-readable (~246 KB)              |
| `ISO_IEC_39075(en)-features.xml`                 | **every optional feature, with its ID and name**          |
| `ISO_IEC_39075(en)-conditions.xml`               | **every GQLSTATUS condition** — 12 classes, 68 subclasses |
| `ISO_IEC_39075(en)-implementation-defined.xml`   | what an implementation must DOCUMENT (codes start `D`)    |
| `ISO_IEC_39075(en)-implementation-dependent.xml` | what it may do FREELY (codes start `U`)                   |

Implementation-dependent code letters: second character is `A` Actions, `D` Defaults, `L` Limits,
`S` Sequencing, `V` Values/Constants, `W` Ways and means.

Only the **prose** of 39075 is paywalled (CHF 227, 610 pages).

## Findings already drawn from them

Kept in `docs/conformance/references.md` (and audit items 68-69), not duplicated here, so there is
one place to update. Cite by code — `US008`, `UA004`, `22012` — which is how a conformance claim
should read anyway.

## The lesson that put this directory here

"The standard is paywalled" was read as "the facts are unavailable." `docs/conformance/references.md`
asserted twice that the Feature-ID annex was behind the paywall and built a whole section on
reconstructing it from vendor reproductions; audit item 69 was argued from first principles for an
afternoon. Both answers were in free XML files the whole time. **Check the directory first.**
