extends Node
class_name FixtureStateService

signal night_changed(night: int)

var current_night: int = 1
var inventory: Array[String] = []

func advance_night() -> void:
	current_night += 1
	night_changed.emit(current_night)

func remember_item(item_id: String) -> void:
	inventory.append(item_id)
