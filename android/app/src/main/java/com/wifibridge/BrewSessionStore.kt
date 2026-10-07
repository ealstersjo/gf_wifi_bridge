package com.wifibridge

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class BrewSessionStore(context: Context) : SQLiteOpenHelper(context, "brew_sessions.db", null, 4) {
  override fun onConfigure(db: SQLiteDatabase) {
    db.setForeignKeyConstraintsEnabled(true)
  }

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL("""CREATE TABLE brew_sessions (
      id TEXT PRIMARY KEY, name TEXT, started_at TEXT NOT NULL, ended_at TEXT,
      status TEXT NOT NULL CHECK(status IN ('ACTIVE','COMPLETED'))
    )""")
    db.execSQL("""CREATE TABLE telemetry_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      actual_temperature_c REAL NOT NULL, target_temperature_c REAL,
      heater_enabled INTEGER, heater_output_percent REAL, pump_enabled INTEGER, rssi INTEGER,
      FOREIGN KEY(session_id) REFERENCES brew_sessions(id)
    )""")
    db.execSQL("""CREATE TABLE brew_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      type TEXT NOT NULL, source TEXT NOT NULL, payload_json TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES brew_sessions(id)
    )""")
    db.execSQL("CREATE UNIQUE INDEX one_active_brew_session ON brew_sessions(status) WHERE status = 'ACTIVE'")
    db.execSQL("CREATE INDEX telemetry_session_time ON telemetry_samples(session_id, timestamp)")
    db.execSQL("CREATE INDEX events_session_time ON brew_events(session_id, timestamp)")
    db.execSQL("""CREATE TABLE recipes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, style TEXT, notes TEXT,
      planned_batch_volume_l REAL, grain_weight_kg REAL, mash_water_volume_l REAL,
      sparge_water_volume_l REAL, planned_pre_boil_volume_l REAL,
      mash_steps_json TEXT NOT NULL, boil_duration_minutes REAL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      source TEXT, source_recipe_id TEXT, source_format TEXT, source_imported_at TEXT, original_recipe_data_json TEXT, normalized_recipe_json TEXT
    )""")
    db.execSQL("CREATE INDEX recipes_updated ON recipes(updated_at)")
    db.execSQL("ALTER TABLE brew_sessions ADD COLUMN recipe_id TEXT")
    db.execSQL("ALTER TABLE brew_sessions ADD COLUMN recipe_snapshot_json TEXT")
    db.execSQL("ALTER TABLE brew_sessions ADD COLUMN planned_batch_volume_l REAL")
    db.execSQL("ALTER TABLE brew_sessions ADD COLUMN planned_pre_boil_volume_l REAL")
    db.execSQL("ALTER TABLE brew_sessions ADD COLUMN grain_weight_kg REAL")
    db.execSQL("ALTER TABLE brew_sessions ADD COLUMN actual_mash_water_volume_l REAL")
    db.execSQL("ALTER TABLE brew_sessions ADD COLUMN actual_pre_boil_volume_l REAL")
    db.execSQL("ALTER TABLE brew_sessions ADD COLUMN actual_batch_volume_l REAL")
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    if (oldVersion < 2) {
      db.execSQL("""CREATE TABLE IF NOT EXISTS recipes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, style TEXT, notes TEXT,
        planned_batch_volume_l REAL, grain_weight_kg REAL, mash_water_volume_l REAL,
        sparge_water_volume_l REAL, planned_pre_boil_volume_l REAL,
        mash_steps_json TEXT NOT NULL, boil_duration_minutes REAL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        source TEXT, source_recipe_id TEXT, source_format TEXT, source_imported_at TEXT, original_recipe_data_json TEXT, normalized_recipe_json TEXT
      )""")
      db.execSQL("CREATE INDEX IF NOT EXISTS recipes_updated ON recipes(updated_at)")
      listOf(
        "recipe_id TEXT", "recipe_snapshot_json TEXT", "planned_batch_volume_l REAL",
        "planned_pre_boil_volume_l REAL", "grain_weight_kg REAL",
        "actual_mash_water_volume_l REAL", "actual_pre_boil_volume_l REAL", "actual_batch_volume_l REAL",
      ).forEach { column -> db.execSQL("ALTER TABLE brew_sessions ADD COLUMN $column") }
    }
    if (oldVersion < 3) listOf("source TEXT", "source_recipe_id TEXT", "source_format TEXT", "source_imported_at TEXT", "original_recipe_data_json TEXT").forEach { column -> db.execSQL("ALTER TABLE recipes ADD COLUMN $column") }
    if (oldVersion < 4) db.execSQL("ALTER TABLE recipes ADD COLUMN normalized_recipe_json TEXT")
  }

  fun execute(operation: String, payload: JSONObject): String {
    val result: Any = when (operation) {
      "getActive" -> queryOne("SELECT * FROM brew_sessions WHERE status='ACTIVE' LIMIT 1", emptyArray(), ::sessionJson) ?: JSONObject.NULL
      "createSession" -> createSession(payload)
      "endSession" -> endSession(payload)
      "listSessions" -> queryMany("SELECT * FROM brew_sessions ORDER BY started_at DESC", emptyArray(), ::sessionJson)
      "getSession" -> queryOne("SELECT * FROM brew_sessions WHERE id=?", arrayOf(payload.getString("id")), ::sessionJson) ?: JSONObject.NULL
      "insertTelemetry" -> insertTelemetry(payload)
      "listTelemetry" -> listTelemetry(payload)
      "insertEvent" -> insertEvent(payload)
      "listEvents" -> listEvents(payload)
      "listRecipes" -> listRecipes()
      "getRecipe" -> queryOne("SELECT * FROM recipes WHERE id=?", arrayOf(payload.getString("id")), ::recipeJson) ?: JSONObject.NULL
      "saveRecipe" -> saveRecipe(payload)
      "duplicateRecipe" -> duplicateRecipe(payload)
      "deleteRecipe" -> deleteRecipe(payload)
      "deleteSession" -> deleteSession(payload)
      "updateActualValues" -> updateActualValues(payload)
      else -> throw IllegalArgumentException("Unknown session-store operation")
    }
    return if (result === JSONObject.NULL) "null" else result.toString()
  }

  private fun createSession(payload: JSONObject): JSONObject {
    val id = UUID.randomUUID().toString()
    val values = ContentValues().apply {
      put("id", id)
      if (payload.isNull("name")) putNull("name") else put("name", payload.getString("name"))
      put("started_at", payload.getString("startedAt"))
      putNull("ended_at")
      put("status", "ACTIVE")
      if (payload.isNull("recipeId")) putNull("recipe_id") else put("recipe_id", payload.getString("recipeId"))
      if (payload.isNull("recipeSnapshot")) putNull("recipe_snapshot_json") else put("recipe_snapshot_json", payload.getJSONObject("recipeSnapshot").toString())
      putNullableDouble("planned_batch_volume_l", payload.optJSONObject("recipeSnapshot"), "plannedBatchVolumeL")
      putNullableDouble("planned_pre_boil_volume_l", payload.optJSONObject("recipeSnapshot"), "plannedPreBoilVolumeL")
      putNullableDouble("grain_weight_kg", payload.optJSONObject("recipeSnapshot"), "grainWeightKg")
    }
    writableDatabase.insertOrThrow("brew_sessions", null, values)
    return queryOne("SELECT * FROM brew_sessions WHERE id=?", arrayOf(id), ::sessionJson)!!
  }

  private fun endSession(payload: JSONObject): JSONObject {
    val id = payload.getString("id")
    val values = ContentValues().apply {
      put("ended_at", payload.getString("endedAt"))
      put("status", "COMPLETED")
    }
    val changed = writableDatabase.update("brew_sessions", values, "id=? AND status='ACTIVE'", arrayOf(id))
    if (changed != 1) throw IllegalStateException("Active brew session not found")
    return queryOne("SELECT * FROM brew_sessions WHERE id=?", arrayOf(id), ::sessionJson)!!
  }

  private fun insertTelemetry(payload: JSONObject): JSONObject {
    val values = ContentValues().apply {
      put("session_id", payload.getString("sessionId")); put("timestamp", payload.getString("timestamp"))
      put("actual_temperature_c", payload.getDouble("actualTemperatureC"))
      putNullableDouble("target_temperature_c", payload, "targetTemperatureC")
      putNullableBoolean("heater_enabled", payload, "heaterEnabled")
      putNullableDouble("heater_output_percent", payload, "heaterOutputPercent")
      putNullableBoolean("pump_enabled", payload, "pumpEnabled")
      if (payload.isNull("rssi")) putNull("rssi") else put("rssi", payload.getInt("rssi"))
    }
    val id = writableDatabase.insertOrThrow("telemetry_samples", null, values)
    return queryOne("SELECT * FROM telemetry_samples WHERE id=?", arrayOf(id.toString()), ::telemetryJson)!!
  }

  private fun listTelemetry(payload: JSONObject): JSONArray {
    val args = mutableListOf(payload.getString("id"))
    val since = payload.optString("since").takeIf { it.isNotBlank() && it != "null" }
    val where = if (since != null) { args.add(since); "session_id=? AND timestamp>=?" } else "session_id=?"
    args.add(payload.optInt("limit", 20000).coerceIn(1, 20000).toString())
    return queryMany("SELECT * FROM telemetry_samples WHERE $where ORDER BY timestamp ASC LIMIT ?", args.toTypedArray(), ::telemetryJson)
  }

  private fun insertEvent(payload: JSONObject): JSONObject {
    val values = ContentValues().apply {
      put("session_id", payload.getString("sessionId")); put("timestamp", payload.getString("timestamp"))
      put("type", payload.getString("type")); put("source", payload.getString("source"))
      put("payload_json", payload.getJSONObject("payload").toString())
    }
    val id = writableDatabase.insertOrThrow("brew_events", null, values)
    return queryOne("SELECT * FROM brew_events WHERE id=?", arrayOf(id.toString()), ::eventJson)!!
  }

  private fun listEvents(payload: JSONObject): JSONArray = queryMany(
      "SELECT * FROM brew_events WHERE session_id=? ORDER BY timestamp DESC LIMIT ?",
      arrayOf(payload.getString("id"), payload.optInt("limit", 1000).coerceIn(1, 1000).toString()),
      ::eventJson,
  )

  private fun listRecipes(): JSONArray = queryMany("SELECT * FROM recipes ORDER BY updated_at DESC", emptyArray(), ::recipeJson)

  private fun saveRecipe(payload: JSONObject): JSONObject {
    val now = payload.optString("updatedAt").ifBlank { java.time.Instant.now().toString() }
    val id = payload.optString("id").ifBlank { UUID.randomUUID().toString() }
    val existing = queryOne("SELECT created_at FROM recipes WHERE id=?", arrayOf(id)) { cursor ->
      if (cursor.isNull(cursor.getColumnIndexOrThrow("created_at"))) null else cursor.getString(cursor.getColumnIndexOrThrow("created_at"))
    }
    val values = ContentValues().apply {
      put("id", id); put("name", payload.getString("name")); putNullableString("style", payload, "style"); putNullableString("notes", payload, "notes")
      putNullableDouble("planned_batch_volume_l", payload, "plannedBatchVolumeL"); putNullableDouble("grain_weight_kg", payload, "grainWeightKg")
      putNullableDouble("mash_water_volume_l", payload, "mashWaterVolumeL"); putNullableDouble("sparge_water_volume_l", payload, "spargeWaterVolumeL")
      putNullableDouble("planned_pre_boil_volume_l", payload, "plannedPreBoilVolumeL"); put("mash_steps_json", payload.optJSONArray("mashSteps")?.toString() ?: "[]")
      putNullableDouble("boil_duration_minutes", payload, "boilDurationMinutes"); put("created_at", existing ?: payload.optString("createdAt").ifBlank { now }); put("updated_at", now)
      putNullableString("source", payload, "source"); putNullableString("source_recipe_id", payload, "sourceRecipeId"); putNullableString("source_format", payload, "sourceFormat"); putNullableString("source_imported_at", payload, "sourceImportedAt")
      if (payload.isNull("originalRecipeData")) putNull("original_recipe_data_json") else put("original_recipe_data_json", payload.opt("originalRecipeData").toString())
      put("normalized_recipe_json", payload.toString())
    }
    writableDatabase.insertWithOnConflict("recipes", null, values, SQLiteDatabase.CONFLICT_REPLACE)
    return queryOne("SELECT * FROM recipes WHERE id=?", arrayOf(id), ::recipeJson)!!
  }

  private fun duplicateRecipe(payload: JSONObject): JSONObject {
    val original = queryOne("SELECT * FROM recipes WHERE id=?", arrayOf(payload.getString("id")), ::recipeJson)
        ?: throw IllegalArgumentException("Recipe not found")
    val copy = JSONObject(original.toString()).apply { remove("id"); put("name", payload.optString("name").ifBlank { "${getString("name")} copy" }); remove("createdAt"); remove("updatedAt") }
    return saveRecipe(copy)
  }

  private fun deleteRecipe(payload: JSONObject) {
    writableDatabase.delete("recipes", "id=?", arrayOf(payload.getString("id")))
  }

  private fun deleteSession(payload: JSONObject) {
    val id = payload.getString("id")
    val db = writableDatabase
    db.beginTransaction()
    try {
      val status = queryOne("SELECT status FROM brew_sessions WHERE id=?", arrayOf(id)) { cursor -> cursor.string("status") }
        ?: throw IllegalArgumentException("Brew session not found")
      if (status == "ACTIVE") throw IllegalStateException("SESSION_ACTIVE: End the active brew session before deleting it.")
      db.delete("telemetry_samples", "session_id=?", arrayOf(id))
      db.delete("brew_events", "session_id=?", arrayOf(id))
      val deleted = db.delete("brew_sessions", "id=? AND status='COMPLETED'", arrayOf(id))
      if (deleted != 1) throw IllegalArgumentException("Brew session not found")
      db.setTransactionSuccessful()
    } finally { db.endTransaction() }
  }

  private fun updateActualValues(payload: JSONObject): JSONObject {
    val values = ContentValues().apply {
      putNullableDouble("actual_mash_water_volume_l", payload.optJSONObject("actual"), "mashWaterVolumeL")
      putNullableDouble("actual_pre_boil_volume_l", payload.optJSONObject("actual"), "preBoilVolumeL")
      putNullableDouble("actual_batch_volume_l", payload.optJSONObject("actual"), "batchVolumeL")
    }
    writableDatabase.update("brew_sessions", values, "id=?", arrayOf(payload.getString("id")))
    return queryOne("SELECT * FROM brew_sessions WHERE id=?", arrayOf(payload.getString("id")), ::sessionJson)!!
  }

  private fun ContentValues.putNullableDouble(column: String, json: JSONObject?, key: String) {
    if (json == null || json.isNull(key)) putNull(column) else put(column, json.getDouble(key))
  }
  private fun ContentValues.putNullableString(column: String, json: JSONObject, key: String) {
    if (json.isNull(key)) putNull(column) else put(column, json.getString(key))
  }
  private fun ContentValues.putNullableBoolean(column: String, json: JSONObject, key: String) {
    if (json.isNull(key)) putNull(column) else put(column, if (json.getBoolean(key)) 1 else 0)
  }

  private fun sessionJson(cursor: Cursor) = JSONObject().apply {
    put("id", cursor.string("id")); put("name", cursor.nullableString("name"))
    put("startedAt", cursor.string("started_at")); put("endedAt", cursor.nullableString("ended_at"))
    put("status", cursor.string("status"))
    put("recipeId", cursor.nullableString("recipe_id")); put("recipeSnapshot", cursor.nullableJson("recipe_snapshot_json"))
    put("plannedBatchVolumeL", cursor.nullableDouble("planned_batch_volume_l")); put("plannedPreBoilVolumeL", cursor.nullableDouble("planned_pre_boil_volume_l")); put("grainWeightKg", cursor.nullableDouble("grain_weight_kg"))
    put("actual", JSONObject().apply { put("mashWaterVolumeL", cursor.nullableDouble("actual_mash_water_volume_l")); put("preBoilVolumeL", cursor.nullableDouble("actual_pre_boil_volume_l")); put("batchVolumeL", cursor.nullableDouble("actual_batch_volume_l")) })
    put("currentPhase", "UNKNOWN")
  }
  private fun recipeJson(cursor: Cursor) = JSONObject().apply {
    put("id", cursor.string("id")); put("name", cursor.string("name")); put("style", cursor.nullableString("style")); put("notes", cursor.nullableString("notes"))
    put("plannedBatchVolumeL", cursor.nullableDouble("planned_batch_volume_l")); put("grainWeightKg", cursor.nullableDouble("grain_weight_kg")); put("mashWaterVolumeL", cursor.nullableDouble("mash_water_volume_l")); put("spargeWaterVolumeL", cursor.nullableDouble("sparge_water_volume_l")); put("plannedPreBoilVolumeL", cursor.nullableDouble("planned_pre_boil_volume_l")); put("mashSteps", JSONArray(cursor.string("mash_steps_json"))); put("boilDurationMinutes", cursor.nullableDouble("boil_duration_minutes")); put("createdAt", cursor.string("created_at")); put("updatedAt", cursor.string("updated_at")); put("source", cursor.nullableString("source")); put("sourceRecipeId", cursor.nullableString("source_recipe_id")); put("sourceFormat", cursor.nullableString("source_format")); put("sourceImportedAt", cursor.nullableString("source_imported_at"))
    val original = cursor.nullableString("original_recipe_data_json")
    put("originalRecipeData", if (original is String) runCatching { JSONObject(original) }.getOrNull() ?: JSONObject.NULL else JSONObject.NULL)
    val normalized = cursor.nullableString("normalized_recipe_json")
    if (normalized is String) runCatching { JSONObject(normalized).keys().forEach { key -> put(key, JSONObject(normalized).get(key)) } }
  }
  private fun telemetryJson(cursor: Cursor) = JSONObject().apply {
    put("id", cursor.long("id")); put("sessionId", cursor.string("session_id")); put("timestamp", cursor.string("timestamp"))
    put("actualTemperatureC", cursor.double("actual_temperature_c")); put("targetTemperatureC", cursor.nullableDouble("target_temperature_c"))
    put("heaterEnabled", cursor.nullableBoolean("heater_enabled")); put("heaterOutputPercent", cursor.nullableDouble("heater_output_percent"))
    put("pumpEnabled", cursor.nullableBoolean("pump_enabled")); put("rssi", cursor.nullableInt("rssi"))
  }
  private fun eventJson(cursor: Cursor) = JSONObject().apply {
    put("id", cursor.long("id")); put("sessionId", cursor.string("session_id")); put("timestamp", cursor.string("timestamp"))
    put("type", cursor.string("type")); put("source", cursor.string("source")); put("payload", JSONObject(cursor.string("payload_json")))
  }

  private fun <T> queryOne(sql: String, args: Array<String>, mapper: (Cursor) -> T): T? =
      readableDatabase.rawQuery(sql, args).use { if (it.moveToFirst()) mapper(it) else null }
  private fun <T> queryMany(sql: String, args: Array<String>, mapper: (Cursor) -> T): JSONArray =
      readableDatabase.rawQuery(sql, args).use { cursor -> JSONArray().apply { while (cursor.moveToNext()) put(mapper(cursor)) } }
  private fun Cursor.index(name: String) = getColumnIndexOrThrow(name)
  private fun Cursor.string(name: String) = getString(index(name))
  private fun Cursor.long(name: String) = getLong(index(name))
  private fun Cursor.double(name: String) = getDouble(index(name))
  private fun Cursor.nullableString(name: String): Any = if (isNull(index(name))) JSONObject.NULL else getString(index(name))
  private fun Cursor.nullableDouble(name: String): Any = if (isNull(index(name))) JSONObject.NULL else getDouble(index(name))
  private fun Cursor.nullableInt(name: String): Any = if (isNull(index(name))) JSONObject.NULL else getInt(index(name))
  private fun Cursor.nullableBoolean(name: String): Any = if (isNull(index(name))) JSONObject.NULL else getInt(index(name)) != 0
  private fun Cursor.nullableJson(name: String): Any = if (isNull(index(name))) JSONObject.NULL else JSONObject(getString(index(name)))
}
