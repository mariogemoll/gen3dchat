const out = document.querySelector<HTMLParagraphElement>('#out')!
fetch('/api/hello')
  .then((r) => r.json())
  .then((d) => (out.textContent = `API says: ${JSON.stringify(d)}`))
  .catch((e) => (out.textContent = `error: ${String(e)}`))

const form = document.querySelector<HTMLFormElement>('#echoForm')!
const echoOut = document.querySelector<HTMLPreElement>('#echoOut')!
form.addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const msg = new FormData(form).get('msg')
  const res = await fetch('/api/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msg }),
  })
  echoOut.textContent = JSON.stringify(await res.json(), null, 2)
})
