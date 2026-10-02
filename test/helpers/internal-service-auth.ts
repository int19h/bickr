import { internalServiceAuthHeader } from "@bickr/shared/internal-service";

// Matches the isolated Wrangler test binding; never a live environment secret.
export const internalServiceTestEnv = { INTERNAL_SERVICE_SECRET: "test-internal-service-secret" };
export const internalServiceTestHeaders = { [internalServiceAuthHeader]: internalServiceTestEnv.INTERNAL_SERVICE_SECRET };
