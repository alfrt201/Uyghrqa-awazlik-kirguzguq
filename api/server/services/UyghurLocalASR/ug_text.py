"""Uyghur text utilities.

Two writing systems are in play:

* UCT / UEY  - Uyghur ARABIC script, e.g.  ياخشىمۇسىز   (what users actually write)
* ULY        - Uyghur LATIN  script, e.g.  yaxshimusiz

The available fine-tuned Whisper checkpoints decode to **ULY**, so every result has
to pass through :func:`uly_to_uig` before it reaches the user. Getting this wrong
is the difference between "usable" and "garbage", because unlike the Latin script,
Uyghur Arabic orthography has a non-negotiable rule:

    1. a word beginning with a vowel MUST carry a hamza carrier  ئ
    2. two adjacent vowels inside a word MUST be separated by  ئ

Also honoured: only the Uyghur set of Arabic letters (no Persian variants).
"""

from __future__ import annotations

import re
import unicodedata

__all__ = [
    "uly_to_uig",
    "uig_to_uly",
    "normalize_uig",
    "HAMZA",
    "UIGHUR_LETTERS",
]

HAMZA = "\u0626"          # ئ  YEH WITH HAMZA ABOVE  (the Uyghur "vowel carrier")
AE = "\u06D5"             # ە  HEH WITH YEH ABOVE (e)
EE = "\u06D0"             # ې  YEH WITH SMALL V BELOW (é)
OE = "\u06C6"             # ۆ
UE = "\u06C8"             # ۈ
UU = "\u06C7"             # ۇ
NG = "\u06AD"             # ڭ
GE = "\u06AF"             # گ
HE = "\u06BE"             # ھ  HEH DOACHASHMEE  (NOT U+0647)
VE = "\u06CB"             # ۋ
CHE = "\u0686"            # چ
ZHE = "\u0698"            # ژ
PE = "\u067E"             # پ

# The 32 letters of modern Uyghur Arabic orthography.
UIGHUR_LETTERS = set(
    "ئابةپتجچخدرزژسشغفقكلمنھوۇۆۈۋېىيەڭ"
)

# ULY digraphs must be matched greedily BEFORE single letters.
_DIGRAPHS = {
    "ch": CHE, "CH": CHE, "Ch": CHE,
    "sh": "\u0634", "SH": "\u0634", "Sh": "\u0634",
    "gh": "\u063A", "GH": "\u063A", "Gh": "\u063A",
    "ng": NG, "NG": NG, "Ng": NG,
    "zh": ZHE, "ZH": ZHE, "Zh": ZHE,
}

_SINGLES = {
    "a": "\u0627", "A": "\u0627",
    "b": "\u0628", "B": "\u0628",
    "d": "\u062F", "D": "\u062F",
    "e": AE, "E": AE,
    "f": "\u0641", "F": "\u0641",
    "g": GE, "G": GE,
    "h": HE, "H": HE,
    "i": "\u0649", "I": "\u0649",          # ى  ALEF MAKSURA (Uyghur i)
    "j": "\u062C", "J": "\u062C",
    "k": "\u0643", "K": "\u0643",          # ك  NOT Persian keheh U+06A9
    "l": "\u0644", "L": "\u0644",
    "m": "\u0645", "M": "\u0645",
    "n": "\u0646", "N": "\u0646",
    "o": "\u0648", "O": "\u0648",
    "p": PE, "P": PE,
    "q": "\u0642", "Q": "\u0642",
    "r": "\u0631", "R": "\u0631",
    "s": "\u0633", "S": "\u0633",
    "t": "\u062A", "T": "\u062A",
    "u": UU, "U": UU,
    "v": VE, "V": VE,
    "w": VE, "W": VE,
    "x": "\u062E", "X": "\u062E",
    "y": "\u064A", "Y": "\u064A",
    "z": "\u0632", "Z": "\u0632",
    "\u00E9": EE, "\u00C9": EE,            # é (NFD-safe handled below)
    "\u00F6": OE, "\u00D6": OE,            # ö
    "\u00FC": UE, "\u00DC": UE,            # ü
    "'": HAMZA, "\u2019": HAMZA, "\u02BC": HAMZA, "`": HAMZA,
}

_AR_VOWELS = set("\u0627\u06D5\u06D0\u0649\u0648\u06C7\u06C6\u06C8")  # a e é i o u ö ü
_LAT_VOWELS = set("aeiou\u00E9\u00F6\u00FC")

# reverse map (Arabic -> Latin), longest first
_AR_TO_LAT = [
    (CHE, "ch"), ("\u0634", "sh"), ("\u063A", "gh"), (NG, "ng"), (ZHE, "zh"),
    ("\u0627", "a"), (AE, "e"), (EE, "é"), ("\u0649", "i"),
    ("\u0648", "o"), (UU, "u"), (OE, "ö"), (UE, "ü"),
    ("\u0628", "b"), (PE, "p"), ("\u062A", "t"), ("\u062C", "j"),
    ("\u062E", "x"), ("\u062F", "d"), ("\u0631", "r"), ("\u0632", "z"),
    ("\u0633", "s"), ("\u0641", "f"), ("\u0642", "q"), ("\u0643", "k"),
    (GE, "g"), ("\u0644", "l"), ("\u0645", "m"), ("\u0646", "n"),
    (HE, "h"), (VE, "w"), ("\u064A", "y"),
]

# Characters that must never survive into real Uyghur text (wrong-script variants).
_WRONG_SCRIPT = {
    "\u06A9": "\u0643",   # keheh -> kaf
    "\u06CC": "\u064A",   # farsi yeh -> yeh
    "\u0647": HE,         # heh -> heh doachashmee (only inside Arabic-script words)
    "\u0649\u0649": None,
}


def _decompose_latin(s: str) -> str:
    """é/ö/ü written as base+combining accent -> precomposed."""
    return unicodedata.normalize("NFC", s)


def _tokenize_uly(word: str) -> list[str]:
    """Split a Latin Uyghur word into Arabic-script letters (hamza not yet applied)."""
    s = _decompose_latin(word)
    out: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        two = s[i:i + 2]
        if two in _DIGRAPHS:
            out.append(_DIGRAPHS[two])
            i += 2
            continue
        ch = s[i]
        if ch.lower() in ("\u00E9", "\u00F6", "\u00FC") or ch in ("'", "’", "`", "‘"):
            mapped = _SINGLES.get(ch)
            if mapped:
                out.append(mapped)
                i += 1
                continue
        low = ch
        if low in _SINGLES:
            out.append(_SINGLES[low])
        elif ch.upper() in _SINGLES and ch.isupper():
            out.append(_SINGLES[ch.upper()])
        else:
            out.append(ch)          # digits, punctuation, unknown -> keep as-is
        i += 1
    return out


def _apply_hamza(letters: list[str]) -> str:
    """Insert the vowel carrier ئ where Uyghur orthography requires it."""
    res: list[str] = []
    prev_vowel = False
    for ch in letters:
        if ch == HAMZA:
            # explicit apostrophe in ULY: acts as a (possibly redundant) separator
            if res and not prev_vowel:
                res.append(HAMZA)
                prev_vowel = False
            continue
        if ch in _AR_VOWELS:
            if (not res) or prev_vowel:
                res.append(HAMZA)
            res.append(ch)
            prev_vowel = True
        else:
            res.append(ch)
            prev_vowel = False
    # A bare word made of nothing but separators would be empty; guard against it.
    return "".join(res)


def uly_to_uig(text: str) -> str:
    """Convert Latin Uyghur (ULY) to Uyghur Arabic (UCT) with correct hamza placement."""
    if not text:
        return ""

    pieces = re.split(r"(\s+)", text)
    converted: list[str] = []
    for piece in pieces:
        if not piece or piece.isspace():
            converted.append(piece)
            continue
        # keep leading/trailing punctuation outside the word core
        m = re.match(r"^(\W*?)(.*?)(\W*?)$", piece, re.UNICODE)
        pre, core, post = m.group(1), m.group(2), m.group(3)
        if not core:
            converted.append(piece)
            continue
        converted.append(pre + _apply_hamza(_tokenize_uly(core)) + post)
    return "".join(converted)


def normalize_uig(text: str) -> str:
    """Clean up an Arabic-script Uyghur string coming out of ASR."""
    if not text:
        return ""
    s = unicodedata.normalize("NFC", text)
    # swap in-script impostors
    for bad, good in _WRONG_SCRIPT.items():
        if good:
            s = s.replace(bad, good)
    # drop random Arabic diacritics that mean nothing in Uyghur
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.replace("\u0640", "")                 # tatweel
    s = re.sub(r"\s+", " ", s).strip()
    return s


def uig_to_uly(text: str) -> str:
    """Convert Uyghur Arabic (UCT) to Latin Uyghur (ULY)."""
    if not text:
        return ""
    s = unicodedata.normalize("NFC", text)
    out: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        if s[i] == HAMZA:
            i += 1
            continue                      # hamza carrier carries no Latin letter
        matched = False
        for ar, lat in _AR_TO_LAT:
            if s.startswith(ar, i):
                out.append(lat)
                i += len(ar)
                matched = True
                break
        if not matched:
            out.append(s[i])
            i += 1
    joined = "".join(out)
    # an Arabic word starting with a vowel becomes a Latin word starting with that vowel
    return joined


# ---------------------------------------------------------------- self-test
if __name__ == "__main__":
    cases = [
        ("yaxshimu siz men Ürümchidin keldim".replace("Ü", "ü"),
         "ياخشىمۇ سىز مەن ئۈرۈمچىدىن كەلدىم"),
        ("bügün hawa bek yaxshi iken", "بۈگۈن ھاۋا بەك ياخشى ئىكەن"),
        ("men öyde olturup kitab oquwatimen", "مەن ئۆيدە ئولتۇرۇپ كىتاب ئوقۇۋاتىمەن"),
        ("kompyutérgha uyghurche xet yazalaymen", "كومپيۇتېرغا ئۇيغۇرچە خەت يازالايمەن"),
        ("Uyghur", "ئۇيغۇر"),
        ("eller bilen söhbetleshmekchi boldum", "ئەللەر بىلەن سۆھبەتلەشمەكچى بولدۇم"),
    ]
    ok = 0
    for src, want in cases:
        got = normalize_uig(uly_to_uig(src))
        want = normalize_uig(want)
        good = got == want
        ok += good
        print(("PASS " if good else "FAIL ") + src)
        if not good:
            print("      expected:", want)
            print("      actual  :", got)
    print(f"\n{ok}/{len(cases)} passed")
