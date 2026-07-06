Installation Check
---
>**Did the installation work?**

Yes, but I needed to get ChatGPT to help me because the folder name is different from the executable name.
>**What command confirmed that fubar was available?**
```bash
fubar --version
```
>**What did fubar --help show you at first glance?**

It showed the available options and commands for the fubar tool.

Theory
---

>**Based on the help output, I think fubar is probably used for...**

Smart home simulator and controls

Command Map
---
>**Which command seems safest to run first?**
```bash
fubar status
```
>**Which command seems most important?**
```bash
fubar device
```
>**Which command seems like it might change data?**
```bash
fubar set
```
>**What evidence helped you decide?**

The help descriptions for each command

Commands
---

`fubar device list`
>What did the command show?

```
Devices
┌────┬──────┬──────┬────────┬───────┐
│ ID │ Name │ Type │ Online │ Power │
└────┴──────┴──────┴────────┴───────┘
```
>Did it confirm or change your theory about fubar?

It sort of confirmed it, but there were no devices listed.

>What would you try next?

Adding a device somehow.

`fubar status`
>What did the command show?
```md
No homes yet. Create one with `fubar home create "My Home"`.
```

>Did it confirm or change your theory about fubar?

It confirmed that fubar is used for managing smart homes, as it suggested creating a home.

>What would you try next?

Adding a home using the suggested command.


`fubar home create "My Home"`

I think that this command will add a home to the home list.

