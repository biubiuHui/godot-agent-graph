extends Node
class_name FixtureConsumer

const FixtureLimitsScript := preload("res://scripts/fixture_limits.gd")

func class_limit() -> int:
	return FixtureLimits.FIXTURE_LIMIT

func preload_limit() -> int:
	return FixtureLimitsScript.FIXTURE_LIMIT

func ambiguous_limit() -> int:
	return FIXTURE_LIMIT
