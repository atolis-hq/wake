# Public UI access

Wake's API and web UI are local by default. To make the UI available remotely,
run an operator-managed ingress such as ngrok, Cloudflare Tunnel, Tailscale
Funnel, or a company reverse proxy. Wake does not install, start, or store
credentials for an ingress provider.

## Configure Wake

Enable the API and web UI in `config.yaml`. When Wake runs in the Docker
sandbox, bind the API to `0.0.0.0` inside the container so Docker can forward
the port; Wake still publishes that port only to the host loopback interface.

```yaml
surfaces:
  api:
    enabled: true
    host: 0.0.0.0
    port: 4317
  web:
    enabled: true
    publicUrl: https://wake.example.ngrok.app
```

After changing sandbox configuration, recreate its container:

```sh
wake sandbox update
```

Confirm the UI is available from the host before adding an ingress:

```sh
curl http://127.0.0.1:4317
```

`publicUrl` must be the stable HTTPS address assigned by the ingress. Wake
uses it only when rendering GitHub agent-run messages: the **Wake** heading
links to that URL. If it is absent, messages retain an unlinked **Wake**
heading.

## ngrok

Install the ngrok Agent on the host that runs Wake, create an ngrok account,
then save that host's ngrok authtoken in ngrok's own configuration:

```sh
ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
```

Reserve a stable ngrok domain and assign it to the endpoint, then start the
tunnel against Wake's loopback port:

```sh
ngrok http 127.0.0.1:4317 --url https://wake.example.ngrok.app
```

Use that same HTTPS address as `surfaces.web.publicUrl`. Keep the ngrok agent
as a host service if the UI must remain available across logouts and reboots;
it is independent of Wake sandbox rebuilds and updates.

Do not expose the UI anonymously. Wake does not currently authenticate HTTP
requests, so configure ngrok OAuth, IP restrictions, or an equivalent access
policy before sharing the URL. See ngrok's [Share Localhost
quickstart](https://ngrok.com/docs/guides/share-localhost/quickstart) for
installation, domains, and traffic-policy authentication.

## Other ingress providers

Point the provider at `http://127.0.0.1:4317`, preserve HTTPS and access
controls at the edge, and set the resulting stable external URL as
`surfaces.web.publicUrl`. This keeps ingress credentials and lifecycle outside
Wake while preserving a consistent URL in GitHub messages.
