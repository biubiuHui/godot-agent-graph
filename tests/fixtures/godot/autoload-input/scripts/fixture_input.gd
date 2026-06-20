extends Node

func _process(_delta: float) -> void:
	if Input.is_action_pressed("move_left"):
		FixtureState.score += 1
	var root_state := get_node_or_null("/root/FixtureState")
	var tree_state := get_tree().root.get_node_or_null("FixtureState")
	var save_data := FixtureSaveService.load_data()
