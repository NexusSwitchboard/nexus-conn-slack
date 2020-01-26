
# Slack Integration

The Slack connection makes it easy to make your Nexus module integrate
with your custom Slack App in multiple ways:

1) Respond to Events
2) Respond to Interaction Messages
3) Respond to Custom Commands 
4) Send messages to prepped Incoming Webhooks

## Create the  Slack App
Before you can do anything you will need to create a  Slack App.
https://api.slack.com/tutorials/slack-apps-and-postman

What features you enable in the app will dictate which of the features
you are using in your SlackConnection instance.

### Responding to Events With Event API

The Nexus Slack connection tries to simplify usage of the Event API through the use of the SlackEventList type.  By initializing the connection with this list plus your Slack app configuration details including the app ID, signing secret, client key and secret, you can simply define a dictionary of event handlers keyed off of the event name.  

The Slack connection will automatically register those events and functions and handle validating all incoming events for you.  

*** __MORE ON THIS ONCE I IMPLEMENT A MODULE THAT USES IT__

### Responding to Interactions With Interaction API

The Nexus Slack connection tries to simplify usage of the Interaction API through the use of the SlackInteractionList type.  By initializing the connection with this list plus your Slack app configuration details including the app ID, signing secret, client key and secret, you can simply define a dictionary of event handlers keyed off of the event type.  

The SlackConnection will automatically setup the router with an endpoint that will be expecting event requests from slack.  This endpoint will have the following format: `m/<modulename>/slack/events`.  

Here's an example of a module creating an event list that maps event names to handlers:

```typescript
export const events: SlackEventList = {
    app_mention: async (conn: SlackConnection, slackParams: Record<string, any>): Promise<ISlackAckResponse> => {
        conn.apiAsBot.chat.postMessage({
            text: "Hello world!",
            channel: slackParams.channel,
        }).then((resp) => {
           logger("message sent successfully");
        });

        return {
            code: 200
        };
    }
};
```
A few things to note about this example.  

1. We are hiding the entirety of the slack-specific events API interactions from you.
2. If the slack connection was configured properly (`SLACK_CLIENT_OAUTH_TOKEN` required) then you should be able to use the `api` property in the given connection parameter to use the Web API node client directly.
3. The function MUST return an object with at least a `code` property.  This is a requirement enforded by the Slack Event API.  If it doesn't get a response within 3 seconds, it will assume there was an error and cut off the connection.  Of course this doesn't prevent you from making async calls to actions that you believe will take longer than 3 seconds.

### Responding to Commands 

Slack Commands do not appear to have a dedicated Command API as part of the NodeJS slack SDK.  But the Nexus connection provides an abstraction layer to make this a lot easier.  To use it, simply initialize the Slack Connection with a ISlackConfig object that includes one or more ISlackCommand objects in the `commands` property.  

The connection will automatically establish a route and connect the given listeners to the command.  Note that for a single command you can have multiple "sub-commands" which are not a construct native to Slack commands.  This is something that allows you to make the first parameter to the command a "sub-command" which further refines the type of command that will be run.  If you do not want to have sub-commands, you only have to create a single sub-command and make it the default.  If no command is found it will use whatever the default is.

Let's look at an example.  In Slack, we have created an app and registered the command `dox` so that whenever we see `/dox`, it will send a POST request to the registered URL.  

On the Nexus side, the Slack Connection has been given a set of `SlackCommand` objects that look like this.

```typescript
const slackConfig:ISlackConfig = {
    ...
    commands: [{
        command: "dox",
        defaultSubCommand: "help",
        subCommandListeners: {
            "help": (conn: SlackConnection,textWithoutAction: string[],slackParams: Record<string, any>) => {
                console.log("help goes here");
            }
            "list": (conn: SlackConnection,textWithoutAction: string[],slackParams: Record<string, any>) => {
                console.log("list things");
            }
        }
    }]
}
```

With that as your configuration, in your module's connections loader you can do the following:

```typescript
return {
    "slack": new SlackConnection(slackConfig);
}
```

