do $$
declare
  admin_email text := 'daniielneves77@gmail.com';
  admin_user_id uuid;
begin
  admin_email := lower(admin_email);

  select id
    into admin_user_id
  from auth.users
  where lower(email) = admin_email
  limit 1;

  delete from public.user_states s
  using auth.users u
  where s.user_id = u.id
    and lower(u.email) <> admin_email;

  delete from public.app_profiles
  where email is null
     or lower(email) <> admin_email;

  delete from public.allowed_emails
  where email is null
     or lower(email) <> admin_email;

  delete from auth.users
  where lower(email) <> admin_email;

  insert into public.allowed_emails (
    email,
    full_name,
    role,
    status,
    valid_until,
    valid_until_at,
    temp_password,
    must_change_password,
    is_trial,
    account_created_at,
    claimed_at,
    created_by,
    updated_at
  )
  values (
    admin_email,
    'Administrador',
    'admin',
    'active',
    date '2099-12-31',
    timestamp with time zone '2099-12-31 23:59:59+00',
    null,
    false,
    false,
    now(),
    now(),
    admin_user_id,
    now()
  )
  on conflict (email) do update
    set role = 'admin',
        status = 'active',
        valid_until = excluded.valid_until,
        valid_until_at = excluded.valid_until_at,
        temp_password = null,
        must_change_password = false,
        is_trial = false,
        account_created_at = coalesce(public.allowed_emails.account_created_at, now()),
        claimed_at = coalesce(public.allowed_emails.claimed_at, now()),
        created_by = coalesce(public.allowed_emails.created_by, admin_user_id),
        updated_at = now();

  if admin_user_id is not null then
    update auth.users
       set banned_until = null,
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           updated_at = now()
     where id = admin_user_id;

    insert into public.app_profiles (
      user_id,
      email,
      full_name,
      role,
      status,
      valid_until,
      valid_until_at,
      is_trial,
      created_by,
      updated_at,
      last_login_at
    )
    values (
      admin_user_id,
      admin_email,
      'Administrador',
      'admin',
      'active',
      date '2099-12-31',
      timestamp with time zone '2099-12-31 23:59:59+00',
      false,
      admin_user_id,
      now(),
      now()
    )
    on conflict (user_id) do update
      set email = excluded.email,
          role = 'admin',
          status = 'active',
          valid_until = excluded.valid_until,
          valid_until_at = excluded.valid_until_at,
          is_trial = false,
          updated_at = now();
  end if;

  if exists (
    select 1
    from information_schema.sequences
    where sequence_schema = 'public'
      and sequence_name = 'trial_account_number_seq'
  ) then
    alter sequence public.trial_account_number_seq restart with 1;
  end if;
end $$;

select 'allowed_emails' as tabela, email, role, status, valid_until
from public.allowed_emails
order by email;

select 'app_profiles' as tabela, email, role, status, valid_until
from public.app_profiles
order by email;

select 'auth_users' as tabela, email, null::text as role, null::text as status, null::date as valid_until
from auth.users
order by email;
