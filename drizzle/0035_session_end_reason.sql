-- Why a session ended early, so the person can be told (for example: they signed in on another device).
ALTER TABLE "sessions" ADD COLUMN "ended_reason" varchar(20);
