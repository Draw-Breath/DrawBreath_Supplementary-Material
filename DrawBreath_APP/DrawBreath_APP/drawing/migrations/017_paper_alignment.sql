ALTER TABLE canvas_operations DROP CONSTRAINT IF EXISTS canvas_operations_operation_type_check;
ALTER TABLE canvas_operations
  ADD CONSTRAINT canvas_operations_operation_type_check
  CHECK (operation_type IN ('stroke', 'erase', 'undo', 'redo', 'clear', 'tool_change'));

ALTER TABLE tasks ALTER COLUMN new_attempts_allowed SET DEFAULT false;
