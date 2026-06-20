extends CharacterBody2D
class_name FixtureActor

signal health_depleted
signal interacted(target: Node)

@export var speed: float = 180.0
@export var display_name: String = "Fixture Hero"

const StatsResource := preload("res://resources/fixture_stats.tres")

var health: int = 100
var cached_targets: Array[Node] = []

class DamagePacket:
	var amount: int = 0
	var source: String = ""

func _ready() -> void:
	# 中文注释：真实项目里经常会出现本地化备注。
	$Camera.make_current()
	FixtureState.night_changed.connect(_on_night_changed)
	health = StatsResource.max_health if "max_health" in StatsResource else health

func _physics_process(delta: float) -> void:
	var direction := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	velocity = direction * speed
	move_and_slide()
	if Input.is_action_just_pressed("interact"):
		_try_interact()
	if Input.is_action_pressed("jump"):
		_apply_jump_buffer(delta)

func apply_damage(packet: DamagePacket) -> void:
	health -= packet.amount
	if health <= 0:
		health_depleted.emit()

func _try_interact() -> void:
	var area := get_node("InteractArea")
	interacted.emit(area)
	FixtureState.remember_item("sample_item")

func _apply_jump_buffer(_delta: float) -> void:
	pass

func _on_night_changed(_night: int) -> void:
	%HealthBar.value = health
