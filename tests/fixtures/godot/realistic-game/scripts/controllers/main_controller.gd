extends Node2D
class_name MainController

@export var stats: Resource

var player: FixtureActor

func _ready() -> void:
	player = $FixtureActor as FixtureActor
	player.health_depleted.connect(_on_player_health_depleted)
	player.interacted.connect(Callable(self, "_on_player_interacted"))
	FixtureState.advance_night()

func _on_player_health_depleted() -> void:
	print("player defeated")

func _on_player_interacted(target: Node) -> void:
	if target != null:
		print(target.name)
