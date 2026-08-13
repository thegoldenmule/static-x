extends Node

## Five warnings and no errors. The file next to it, parse_error.gd,
## exists to show what happens when that is not true: a hard parse error
## suppresses the whole warning pass, so this file has to stay clean or
## it stops testing what it is for.

signal never_emitted
var _never_read: int = 1

func unreachable() -> void:
	return
	print("dead")

func unused_param(thing: int) -> void:
	pass

func int_div() -> void:
	var a := 3 / 2
	print(a)
