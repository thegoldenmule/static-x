class_name Player
extends Node2D

## The signal main.tscn connects to. Renaming it through the language
## server rewrites this line and the emit below, and leaves the scene's
## [connection signal="died"] pointing at a name that no longer exists.
signal died(reason: String)

@export var speed: float = 100.0
var _hp: int = 3

func take_damage(amount: int) -> void:
	_hp -= amount
	if _hp <= 0:
		died.emit("hp")
