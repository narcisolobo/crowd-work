-- Venues aren't moderated today — publicly readable, but nothing can insert
-- one. Needed because venue creation now happens inside the same
-- authenticated client call that approves (or direct-adds) a listing.
create policy "moderators can insert venues"
  on venues for insert
  to authenticated
  with check (true);

-- Extend the anonymous report-form policy to also allow proposing a brand
-- new listing, not just a correction to an existing one. Kept as an `or`
-- between the two proposal shapes (rather than one loosened check) since a
-- new listing has no listing_id to attach a correction to.
drop policy "anyone can submit a correction report" on moderation_queue;

create policy "anyone can submit a correction report or a new listing"
  on moderation_queue for insert
  to anon
  with check (
    (
      change_type in ('update', 'cancellation')
      and origin = 'report_form'
      and listing_id is not null
      and correction_note is not null
      and proposed_by is null
      and proposed_reason is null
      and confirmed_by is null
      and status = 'pending'
    )
    or (
      change_type = 'new'
      and origin = 'submission_form'
      and listing_id is null
      and proposed_data is not null
      and proposed_by is null
      and proposed_reason is null
      and confirmed_by is null
      and status = 'pending'
    )
  );

-- Moderators have only ever UPDATEd existing queue rows (approving/rejecting
-- something already there). Direct-add is the first authenticated INSERT
-- path — allowed only when the row already arrives fully decided and
-- self-attributed, so this can never be used to sneak in a pending entry or
-- attribute an approval to someone else.
create policy "moderators can directly insert a pre-approved new listing"
  on moderation_queue for insert
  to authenticated
  with check (
    change_type = 'new'
    and origin = 'moderator_direct_add'
    and status = 'approved'
    and approved_by = auth.uid()
    and decided_at is not null
  );