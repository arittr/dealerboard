import { type ProviderQuotaAccount, QUOTA_ACCOUNTS_LIMIT } from "../quota-snapshot";

export type AccountInventoryRead = {
  accounts: readonly ProviderQuotaAccount[];
  completeInventory: boolean;
};

export type AccountReconciliation = { kind: "ok"; accounts: ProviderQuotaAccount[] } | { kind: "overflow" };

/** Reconcile source observations without advancing measurements on failed reads. */
export function reconcileQuotaAccounts(
  previous: readonly ProviderQuotaAccount[],
  read: AccountInventoryRead,
): AccountReconciliation {
  const retained = new Map(previous.map((account) => [account.id, account]));
  const observed = new Map(read.accounts.map((account) => [account.id, account]));
  const inventory = read.completeInventory ? observed : new Map([...retained, ...observed]);
  if (inventory.size > QUOTA_ACCOUNTS_LIMIT) return { kind: "overflow" };
  const activeId = read.accounts.find((account) => account.active === true)?.id;
  const accounts = [...inventory.values()].map((source) => {
    const id = source.id;
    const old = retained.get(id);
    const observation = observed.get(id);
    const success = observation !== undefined && observation.issue === null;
    const measurement =
      !success &&
      old?.fetchedAt !== null &&
      old?.fetchedAt !== undefined &&
      (source.fetchedAt === null || Date.parse(source.fetchedAt) <= Date.parse(old.fetchedAt))
        ? old
        : source;
    const issue = success
      ? null
      : source.issue === null || source.issue === "unavailable"
        ? (old?.issue ?? "unavailable")
        : source.issue;
    const active = observation?.active ?? (observation === undefined ? source.active : null);
    return {
      ...measurement,
      id,
      label: old?.label ?? source.label,
      active: active === true && activeId !== undefined && activeId !== id ? false : active,
      issue,
      unavailable: issue !== null,
    };
  });
  accounts.sort((left, right) => Number(left.label) - Number(right.label));
  return { kind: "ok", accounts };
}
