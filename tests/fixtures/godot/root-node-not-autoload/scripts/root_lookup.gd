extends Node
class_name RootLookup

func _ready() -> void:
	var root_node := get_node_or_null("/root/FixtureSaveService")
	var tree_root_node := get_tree().root.get_node_or_null("FixtureSaveService")
