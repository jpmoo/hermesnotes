"""
Is there a sign-in code in this message, and which part of it is the code?

Pure: text in, code (or None) out. Kept apart from the listener so the
guessing can be tried against sample messages without a server.

A code is only looked for in a message that says it is one — "code",
"verification", "passcode" and their neighbours. Without that, every message
with a number in it is a candidate: a street address, an order number, "see
you at 1530". With it, the remaining question is which number, and the answer
is ranked:

1. The origin-bound form Apple and Google ask senders to use, `@site.com #123456`.
   It names the code outright.
2. A code next to the word: "code: 123456", "code is 123456", "123456 is your
   code". Google's "G-123456" is handed over as 123456, which is what its field
   accepts.
3. Failing those, the only code-shaped token in the message. Two candidates and
   no word to choose between them is a guess, and a wrong code on the clipboard
   is worse than none, so that returns nothing.
"""

from __future__ import annotations

import re

_KEYWORD = re.compile(
    r"\b(?:code|codes|passcode|password|one[- ]time|otp|pin|2fa|mfa|verif\w*|authenticat\w*"
    r"|security|login|log[- ]in|sign[- ]in|confirm\w*|token|c[oó]digo)\b",
    re.IGNORECASE,
)

# 4–8 digits, optionally split once by a space or hyphen ("123 456", "123-456"),
# or 4–8 letters and digits with at least one digit (an "AB12CD" kind of code).
_TOKEN = r"(?:\d{3,4}[ -]\d{3,4}|\d{4,8}|(?=[A-Z0-9]*\d)[A-Z0-9]{4,8})"

_ORIGIN_BOUND = re.compile(r"@[\w.-]+\.\w+\s+#([A-Za-z0-9-]{4,10})\b")
_AFTER_WORD = re.compile(
    rf"(?:code|passcode|password|otp|pin|token|c[oó]digo)\b[^\w\n]{{0,3}}(?:is|was|:|=)?[^\w\n]{{0,3}}"
    rf"(?:G-)?({_TOKEN})(?![\w-])",
    re.IGNORECASE,
)
_BEFORE_WORD = re.compile(
    rf"(?<![\w$#.,/-])(?:G-)?({_TOKEN})\s+(?:is|es|est|ist)\s+(?:your|the|tu|su|votre|ihr)\b",
    re.IGNORECASE,
)
# A promotion says "code" too, and its code is not one to sign in with.
_PROMO = re.compile(r"\b(?:promo\w*|coupon|discount|voucher|\d+% off|sale|deal|offer|reward)\b", re.IGNORECASE)
_ANY = re.compile(rf"(?<![\w$#.,/:+-])(?:G-)?({_TOKEN})(?![\w%/:-]|[.,]\d)")


def _clean(token: str) -> str:
    return re.sub(r"[ -]", "", token)


def _plausible(token: str) -> bool:
    code = _clean(token)
    if not 4 <= len(code) <= 8:
        return False
    if code.isalpha():
        return False
    # A bare year reads like a four-digit code and almost never is one.
    if len(code) == 4 and code.isdigit() and 1950 <= int(code) <= 2099:
        return False
    return True


def find_code(text: str | None) -> str | None:
    """The sign-in code in `text`, or None if there isn't clearly one."""
    if not text or not _KEYWORD.search(text) or _PROMO.search(text):
        return None
    # Links carry long ids that look like codes; nothing in one is the code.
    body = re.sub(r"https?://\S+|www\.\S+", " ", text)

    if (m := _ORIGIN_BOUND.search(body)) and _plausible(m.group(1)):
        return _clean(m.group(1))
    for pattern in (_AFTER_WORD, _BEFORE_WORD):
        for m in pattern.finditer(body):
            if _plausible(m.group(1)):
                return _clean(m.group(1))

    found = {_clean(m.group(1)) for m in _ANY.finditer(body) if _plausible(m.group(1))}
    # Letters-and-digits tokens are only trusted when they are upper case in the
    # message itself; lower-case ones are words with a digit in, like "covid19".
    found = {c for c in found if c.isdigit() or c.upper() in body}
    return found.pop() if len(found) == 1 else None
