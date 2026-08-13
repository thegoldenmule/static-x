extends Node

## One parse error, and — measured, not assumed — zero warnings reported
## for this file as a result. The unused signal and the unused parameter
## below are both real and both invisible while the error stands.

signal also_never_emitted

func shadow_test(speed) -> void:
	var speed = 2
	print(speed)
