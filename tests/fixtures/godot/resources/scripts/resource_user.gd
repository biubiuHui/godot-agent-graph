extends Node

const FIXTURE_STATS := preload("res://resources/fixture_stats.tres")

func load_runtime_stats() -> Resource:
	return load("res://resources/fixture_stats.tres")
