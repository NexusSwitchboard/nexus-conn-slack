# Nexus Connection - Slack

Nexus is a framework for connecting different services together that is made up of modules and connections.  This repo
is a Slack connection that can plug into any Nexus-based application.

For full documentation on how to use this, visit the the [Nexus documentation here](https://nexus-switchboard.dev/content/connections/slack)

## Development

To make changes to this repo, fork and clone into a directory.  Then:

1. `npm install`
2. `npm run build`
3. `npm link`

The last step hooks your local npm cache to this project instead of pulling from the public NPM registry.   That way, in the project that uses this package, you can run (in the *other* project's directory, not this one):

`npm link @nexus-switchboard/nexus-conn-slack`

