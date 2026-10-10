CREATE TABLE IF NOT EXISTS billing_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  user_id text NOT NULL,
  customer_id text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS billing_customers_user_unique ON billing_customers (user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS billing_customers_customer_unique ON billing_customers (customer_id);
