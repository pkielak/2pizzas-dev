<script>
  import { onMount } from 'svelte';
  import { live } from '../lib/live.mjs';
  import { getJson, postJson } from '../lib/api.mjs';
  import { authUrl } from '../lib/chatauth.mjs';
  import { navigate } from '../lib/router.mjs';

  let active = $state([]);
  let past = $state([]);
  let repos = $state(null);
  let err = $state('');

  const load = async () => {
    try {
      // one fetch carries live + past rows (live rows have ended_at NULL and
      // an active flag — chatSeq ids restart per run, so the rowid-keyed
      // session table is the source of truth for the split)
      const rows = await getJson(authUrl('/api/chat/sessions'));
      active = rows.filter((r) => r.active);
      past = rows.filter((r) => !r.active);
      repos = await getJson(authUrl('/api/chat/repos'));
      err = '';
    } catch (e) { err = e.message; }
  };

  onMount(load);
  // chat create/kill broadcasts on /live/stream — refetch the lists
  $effect(() => { if ($live) load(); });

  const start = async (resumeFrom = null) => {
    try {
      const j = await postJson(authUrl('/api/chat'), { agent: 'pi', ...(resumeFrom ? { resumeFrom } : {}) });
      if (j.id) navigate(`/chat/${j.id}`);
    } catch (e) { alert(e.message); }
  };

  const toggleGrant = async (repo, grant) => {
    if (!grant && !confirm(`revoke ${repo} write access for the chat agent?`)) return;
    try {
      await postJson(authUrl('/api/chat/grant'), { repo, grant });
      load();
    } catch (e) { alert(e.message); }
  };
</script>

{#if err}
  <p class="err">{err}</p>
{/if}

<form id="newchat">
  <button type="button" onclick={() => start()}>start chat</button>
</form>

<h2>active</h2>
<div class="list">
  {#each active as c (c.id)}
    <a class="item" href="/chat/{c.id}" onclick={(e) => { if (navigate(`/chat/${c.id}`)) e.preventDefault(); }}>
      <div class="l1">@{c.agent} <span>#{c.id}</span>
        {#if c.isStreaming}<span class="running">streaming</span>{:else}<span class="success">idle</span>{/if}
      </div>
      <div class="l2">
        {#if c.model}model <span class="model">{c.model}</span> · {/if}
        started {String(c.created_at ?? '').slice(5, 16).replace('T', ' ')} UTC ·
        last activity {String(c.lastActive ?? '').slice(11, 19)} UTC
      </div>
    </a>
  {:else}
    <div class="item"><div class="l2">no active chats</div></div>
  {/each}
</div>

<h2>past sessions</h2>
<div class="list">
  {#each past as r (r.rowid)}
    <div class="item chatrow">
      <a class="chatlink" href="/chat/r{r.rowid}"
         onclick={(e) => { if (navigate(`/chat/r${r.rowid}`)) e.preventDefault(); }}>
        <div class="l1">@{r.agent} <span>#{r.id}</span> <span class="badge">ended</span></div>
        <div class="l2">
          {String(r.created_at ?? '').slice(5, 16)} → {String(r.ended_at ?? '').slice(11, 19) || '?'} UTC ·
          {r.end_reason ?? '?'} · {r.messages} message{r.messages === 1 ? '' : 's'}
        </div>
      </a>
      {#if r.session_dir}<button class="grantbtn" onclick={() => start(r.rowid)}>continue</button>{/if}
    </div>
  {:else}
    <div class="item"><div class="l2">none yet</div></div>
  {/each}
</div>

{#if repos?.hasToken}
  <h2>gitea access — user <code>{repos.chatLogin}</code></h2>
  <p class="meta">
    chat agents act as the separate <code>{repos.chatLogin}</code> Gitea user
    (audit separation from task work). read works everywhere; grant write per repo:
  </p>
  <div class="list">
    {#if repos.repoError}
      <div class="item"><div class="l2">repo list unavailable: <span class="err">{repos.repoError}</span></div></div>
    {:else if repos.repos.length}
      {#each repos.repos as r}
        <div class="item">
          <div class="l1">
            {r}
            {#if repos.grants[r]}<span class="meta">· write since {repos.grants[r]}</span>{/if}
            <span class="access {repos.grants[r] ? 'on' : 'off'}" title={repos.grants[r] ? 'chat user can write here' : 'chat user is read-only here'}>
              {repos.grants[r] ? 'access' : 'no access'}
            </span>
            <button class="grantbtn" class:revoke={repos.grants[r]} onclick={() => toggleGrant(r, !repos.grants[r])}>
              {repos.grants[r] ? 'revoke' : 'grant'}
            </button>
          </div>
        </div>
      {/each}
    {:else}
      <div class="item"><div class="l2">no repos on this instance</div></div>
    {/if}
  </div>
{/if}

<p class="meta">
  each chat is a long-lived gVisor sandbox with one agent.
  {#if repos?.hasToken}
    it has Gitea access as <code>{repos.chatLogin}</code> (write where granted above)
  {:else}
    no Gitea token — it chats and can read the 2pizzas task API, but cannot push or post.
  {/if}
  chats die on 2pizzas restart or after {repos?.idleMin ?? 30} min idle — their transcripts stay
  readable under <i>past sessions</i>.
</p>
