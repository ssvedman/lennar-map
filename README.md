# Community Map

Public map of new-home communities in a residential homebuilding division — location,
utilities, scheduled starts, construction managers, and the trade partner covering each
scope. Mainly so trade partners can look a community up themselves.

Static site on GitHub Pages. No build step.

```
index.html      the application
data.json       communities, starts, utilities, trade assignments
people.json     contacts, referenced from data.json by id
vendor/         Leaflet
tools/          import, validation, tests
```
