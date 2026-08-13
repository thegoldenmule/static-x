extends Node2D

@onready var player: Player = $Player

func _ready() -> void:
	player.take_damage(1)
	# Deliberate: an error diagnostic (sev 1) and an UNUSED_VARIABLE
	# warning (sev 2) from the same line, so a diagnostics tool has both
	# severities to separate.
	var x = undefined_function()

func _on_player_died(reason: String) -> void:
	print(reason)
