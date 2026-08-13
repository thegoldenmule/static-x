extends Node

## Referenced by nothing that opens it. The language server still finds
## the take_damage and Player references below without the client ever
## sending didOpen for this file — which is how a GDScript analysis tool
## avoids opening the whole project.
const PlayerScript = preload("res://player.gd")

func spawn(p: Player) -> void:
	p.take_damage(2)
