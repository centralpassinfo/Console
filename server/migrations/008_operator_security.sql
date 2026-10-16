-- Each authenticator code works once: the last accepted 30-second step is kept
-- and a code from that step or an earlier one is refused.
ALTER TABLE console_users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;

-- Raised when an operator is deactivated or their password or authenticator is
-- reset, which ends every session they already had.
ALTER TABLE console_users ADD COLUMN IF NOT EXISTS session_epoch INTEGER NOT NULL DEFAULT 0;
