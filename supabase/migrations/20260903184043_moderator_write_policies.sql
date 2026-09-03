create policy "moderators can insert listings"
  on listings for insert
  to authenticated
  with check (true);

create policy "moderators can update listings"
  on listings for update
  to authenticated
  using (true)
  with check (true);

create policy "moderators can insert recurrence rules"
  on recurrence_rules for insert
  to authenticated
  with check (true);

create policy "moderators can update recurrence rules"
  on recurrence_rules for update
  to authenticated
  using (true)
  with check (true);

create policy "moderators can insert occurrence exceptions"
  on occurrence_exceptions for insert
  to authenticated
  with check (true);