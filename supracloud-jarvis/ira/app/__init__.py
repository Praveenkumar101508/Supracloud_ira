"""Application assembly package — factory, lifespan, middleware, routers.

`main.py` stays the uvicorn entry point (`main:app`); everything it used to
define inline lives here so each concern can be read and tested on its own.
"""
