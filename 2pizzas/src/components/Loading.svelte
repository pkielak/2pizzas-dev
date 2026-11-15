<script>
  // page-load indicator — the brand squares (sauce/cheese/olives) bouncing
  // on a hard-bordered, offset-shadow surface, matching the .card/.list look
  let { label = 'loading' } = $props();
</script>

<div class="loading" role="status" aria-live="polite">
  <i></i><i></i><i></i>
  <span>{label}</span>
</div>

<style>
  /* centered in the viewport (right of the desktop sidebar) — the box stays
     content-sized; the page has no content yet, so there is nothing to scroll */
  .loading{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:5;display:flex;align-items:center;gap:10px;margin:0;padding:12px 16px;background:var(--surface);border:2px solid var(--line);box-shadow:4px 4px 0 var(--shadow);pointer-events:none}
  @media (min-width:768px){
    .loading{left:calc(50% + 100px)}
  }
  .loading i{width:12px;height:12px;border:2px solid var(--line);animation:ld .9s ease-in-out infinite}
  .loading i:nth-child(1){background:var(--sauce)}
  .loading i:nth-child(2){background:var(--cheese);animation-delay:.15s}
  .loading i:nth-child(3){background:var(--olives);animation-delay:.3s}
  .loading span{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-2)}
  @keyframes ld{0%,100%{transform:translateY(0);opacity:1}50%{transform:translateY(-6px);opacity:.45}}
</style>
