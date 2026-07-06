"""IRA Command Center (PR #68) — natural commands: plan → risk → confirm → execute.

parser.py   turns owner text into a structured intent (never executes)
risk.py     risk engine: low auto / medium confirm / high password+confirm / critical block
planner.py  builds the human-readable execution plan shown before anything runs
executor.py the only module that performs side effects, called by the API layer
"""
