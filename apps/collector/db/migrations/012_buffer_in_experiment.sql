-- task 1.8 (cont.) — mirror the `in_experiment` column onto the Buffer table.
--
-- events_buffer was created `AS events` (migration 002), which snapshots the
-- column list at creation time; it does NOT pick up columns added to `events`
-- afterwards. The consumer inserts into events_buffer, so without this column the
-- pixel's in_experiment value is an unknown field there and is dropped — the row
-- flushes to `events` with the DEFAULT 0, defeating migration 011's 30-day tier.
--
-- ALTER ADD COLUMN (not DROP+CREATE) so any rows currently buffered survive.
-- Kept in a separate file because the migrate runner executes one statement per
-- file and this targets a different table than 011.
ALTER TABLE events_buffer
    ADD COLUMN IF NOT EXISTS in_experiment UInt8 DEFAULT 0 AFTER is_bot;
