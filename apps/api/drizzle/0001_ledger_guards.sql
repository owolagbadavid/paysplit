-- Rules the application must not be able to break, whatever bug it has.

create function paysplit.refuse_change() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'restrict_violation';
end $$;
--> statement-breakpoint
create trigger ledger_entries_immutable before update or delete on paysplit.ledger_entries
  for each row execute function paysplit.refuse_change();
--> statement-breakpoint
create trigger ledger_journals_immutable before update or delete on paysplit.ledger_journals
  for each row execute function paysplit.refuse_change();
--> statement-breakpoint
create trigger audit_logs_immutable before update or delete on paysplit.audit_logs
  for each row execute function paysplit.refuse_change();
--> statement-breakpoint
create trigger ledger_entries_no_truncate before truncate on paysplit.ledger_entries
  for each statement execute function paysplit.refuse_change();
--> statement-breakpoint

-- Debits equal credits for every journal, checked when the transaction commits.
create function paysplit.check_journal_balanced() returns trigger language plpgsql as $$
declare
  target uuid;
  debits bigint;
  credits bigint;
begin
  if tg_table_name = 'ledger_journals' then target := new.id; else target := new.journal_id; end if;
  select coalesce(sum(amount) filter (where direction = 'debit'), 0),
         coalesce(sum(amount) filter (where direction = 'credit'), 0)
    into debits, credits
    from paysplit.ledger_entries where journal_id = target;
  if debits <> credits or debits = 0 then
    raise exception 'Journal % is not balanced: debits %, credits %', target, debits, credits
      using errcode = 'check_violation';
  end if;
  return null;
end $$;
--> statement-breakpoint
create constraint trigger ledger_entries_balanced after insert on paysplit.ledger_entries
  deferrable initially deferred for each row execute function paysplit.check_journal_balanced();
--> statement-breakpoint
create constraint trigger ledger_journals_balanced after insert on paysplit.ledger_journals
  deferrable initially deferred for each row execute function paysplit.check_journal_balanced();
--> statement-breakpoint

-- Customer money can never go negative. Debits take a row lock on the account first, so two concurrent debits
-- cannot both pass the check.
create function paysplit.lock_debited_account() returns trigger language plpgsql as $$
begin
  if new.direction = 'debit' then
    perform 1 from paysplit.ledger_accounts where id = new.account_id and user_id is not null for update;
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger ledger_entries_lock before insert on paysplit.ledger_entries
  for each row execute function paysplit.lock_debited_account();
--> statement-breakpoint
create function paysplit.check_account_not_negative() returns trigger language plpgsql as $$
declare
  balance bigint;
begin
  if new.direction <> 'debit' then return null; end if;
  if not exists (select 1 from paysplit.ledger_accounts where id = new.account_id and kind = 'liability') then
    return null;
  end if;
  select coalesce(sum(case direction when 'credit' then amount else -amount end), 0)
    into balance from paysplit.ledger_entries where account_id = new.account_id;
  if balance < 0 then
    raise exception 'Account % would go negative', new.account_id using errcode = 'check_violation';
  end if;
  return null;
end $$;
--> statement-breakpoint
create constraint trigger ledger_entries_not_negative after insert on paysplit.ledger_entries
  deferrable initially deferred for each row execute function paysplit.check_account_not_negative();
--> statement-breakpoint

-- Signed balance per account, derived from entries: credit-normal for liabilities, debit-normal otherwise.
create view paysplit.account_balances as
  select a.id as account_id, a.code, a.type, a.kind, a.currency, a.user_id,
         coalesce(sum(case when (a.kind = 'liability') = (e.direction = 'credit') then e.amount else -e.amount end), 0)::bigint as balance
    from paysplit.ledger_accounts a
    left join paysplit.ledger_entries e on e.account_id = a.id
   group by a.id;
--> statement-breakpoint

-- Final states stay final: success may only become reversed, and failed or reversed never change.
create function paysplit.guard_transaction_status() returns trigger language plpgsql as $$
begin
  if old.status in ('failed', 'reversed') and new.status <> old.status
     or old.status = 'success' and new.status not in ('success', 'reversed') then
    raise exception 'Transaction % cannot go from % to %', old.reference, old.status, new.status
      using errcode = 'check_violation';
  end if;
  if new.amount <> old.amount or new.user_id <> old.user_id or new.reference <> old.reference then
    raise exception 'Transaction % identity cannot change', old.reference using errcode = 'check_violation';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger transactions_status_guard before update on paysplit.transactions
  for each row execute function paysplit.guard_transaction_status();
--> statement-breakpoint

insert into paysplit.ledger_accounts (code, kind, type) values
  ('platform:provider_cash', 'asset', 'provider_cash'),
  ('platform:payout_clearing', 'liability', 'payout_clearing'),
  ('platform:provider_fees', 'expense', 'provider_fees');
