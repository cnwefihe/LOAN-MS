-- References of removed test applications, given again to the next new applications (oldest first).
CREATE TABLE "freed_references" (
  "reference" varchar(30) PRIMARY KEY NOT NULL,
  "freed_at" timestamp with time zone DEFAULT now() NOT NULL
);
