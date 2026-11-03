ALTER TABLE "api_keys" ADD COLUMN "endpoint_uuid" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_endpoint_uuid_endpoints_uuid_fk" FOREIGN KEY ("endpoint_uuid") REFERENCES "public"."endpoints"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_endpoint_uuid_idx" ON "api_keys" USING btree ("endpoint_uuid");