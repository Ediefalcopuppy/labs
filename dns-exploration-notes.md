```sh
dig google.com +short
```
only shows the IP addresses associated with the domain name "google.com". The `+short` option provides a concise output, displaying only the relevant IP addresses without additional information.

---

`A` shows the IPv4 address records for a domain. For example, running `dig google.com A` will return the IPv4 addresses associated with "google.com".
`AAAA` shows the IPv6 address records for a domain. For example, running `dig google.com AAAA` will return the IPv6 addresses associated with "google.com".
`MX` shows the mail exchange records for a domain. For example, running `dig google.com MX` will return the mail servers responsible for handling email for "google.com".
`NS` shows the name server records for a domain. For example, running `dig google.com NS` will return the authoritative name servers for "google.com".

---

Both Google and Cloudflare returned the same IP addresses for "google.com" when queried using `dig`. This indicates that both services are providing consistent DNS resolution for the domain.
Returning different IP addresses for the same domain name could indicate that the DNS records are not synchronized between the two services, or that one of the services is using a different set of DNS records.

---

I got a security warning when I opened up the google ip address in my browser. This could be due to several reasons, such as the IP address being associated with a different domain, an expired SSL certificate, or a potential security threat. It's important to verify the legitimacy of the IP address and ensure that it matches the expected domain before proceeding.

---

`curl` uses the default DNS resolver of the system to resolve domain names. It does not have its own DNS resolution mechanism, so it relies on the underlying operating system's DNS configuration to perform name resolution. `dig` grabs the DNS records directly from the authoritative DNS servers, while `curl` uses the system's resolver, which may cache results or use different DNS servers based on the system's configuration.

---

`localhost` is the hostname that refers to the local computer or device. It is typically associated with the IP address `127.0.0.1` for IPv4 and `::1` for IPv6. When you access `localhost`, you are essentially communicating with your own machine, which is useful for testing and development purposes.

---

Before HTTP starts, DNS grabs the IP address associated with the domain name. This process is known as DNS resolution. When you enter a URL in your browser, the browser first checks its cache for the IP address. If it's not found, it queries the DNS resolver configured on your system to obtain the IP address. Once the IP address is retrieved, the browser can establish a connection to the server and initiate the HTTP request.

A DNS resolver is a server that translates domain names into IP addresses. It acts as an intermediary between the client (e.g., a web browser) and the authoritative DNS servers. When a client requests the IP address for a domain, the resolver checks its cache for the answer. If it's not cached, it queries the authoritative DNS servers to obtain the IP address and returns it to the client.

Typing a raw IP address is not the same as typing a domain name. When you type a raw IP address, the browser directly connects to that IP address without performing DNS resolution. However, when you type a domain name, the browser first resolves the domain name to an IP address using DNS before establishing a connection. This means that accessing a website via its IP address may not work as expected if the server is configured to respond only to requests for its domain name.

ChatGPT explained how the `dig` command works very well, including syntax and how to interpret the output. It also provided a clear explanation of the different DNS record types (`A`, `AAAA`, `MX`, `NS`) and their purposes. Additionally, it highlighted the differences between `dig` and `curl` in terms of DNS resolution, as well as the significance of `localhost` and the DNS resolution process before HTTP requests. Overall, the notes provide a comprehensive understanding of DNS exploration and related concepts.

While running the commands, I needed to verify the legitimacy of the IP addresses returned by `dig` and ensure that they matched the expected domain. The security warning encountered when accessing the IP address in the browser emphasized the importance of validating SSL certificates and being cautious about potential security threats, such as my ISP spying on me.