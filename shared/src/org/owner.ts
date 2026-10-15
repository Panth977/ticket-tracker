/** A thing's owner (agents.html §AC) — imported by the schemas, so no commands here. */
import { z } from 'zod';

export const OWNER_KINDS = ['user', 'org'] as const;
export const OwnerRefSchema = z.object({
  kind: z.enum(OWNER_KINDS),
  id: z.string().min(1).max(64),
});
export type OwnerRef = z.infer<typeof OwnerRefSchema>;
export const ownerKeyOf = (o: OwnerRef): string => `${o.kind}:${o.id}`;

/** What every thing (board, artifact, bucket) carries about its owner. */
export const OwnedFieldsShape = {
  /** §AC: who it belongs to. Absent only on data from before §AC (the migration sets it). */
  owner: OwnerRefSchema.optional(),
  /** ownerKeyOf(owner), for where('ownerKey', '==', …). */
  ownerKey: z.string().optional(),
  /**
   * §AC: roles the OWNER ORG gave (uid → the role it gave), so leaving the
   * org takes away only those. A role given directly is not in here.
   */
  orgGranted: z.record(z.string(), z.string()).optional(),
};
