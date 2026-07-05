"""Owner authentication routes (login, logout, refresh).

Token minting/decoding stays in `api.middleware.auth`; this package only owns
the HTTP surface that used to live inline in `main.py`.
"""
