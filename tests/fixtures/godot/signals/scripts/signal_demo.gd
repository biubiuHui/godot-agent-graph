extends Node
class_name SignalDemo

signal health_depleted

func _ready() -> void:
	health_depleted.connect(_on_health_depleted)

func damage() -> void:
	emit_signal("health_depleted")

func _on_health_depleted() -> void:
	pass

func _on_start_button_pressed() -> void:
	damage()
