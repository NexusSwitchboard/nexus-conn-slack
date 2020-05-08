import assert from "assert";

import { SlackEventAdapter } from "@slack/events-api/dist/adapter";
import SlackMessageAdapter, {
    ActionConstraints,
    OptionsConstraints,
    ViewConstraints
} from "@slack/interactive-messages/dist/adapter";
import { createEventAdapter } from "@slack/events-api";
import { createMessageAdapter } from "@slack/interactive-messages";
import { WebClient } from "@slack/web-api";
import { IncomingWebhook } from "@slack/webhook";
import axios, { AxiosError, AxiosResponse } from "axios";
import { Router, Application } from "express";
import { Connection, ConnectionConfig, GlobalConfig, findProperty } from "@nexus-switchboard/nexus-extend";
import { createCommandAdapter, SlackCommandAdapter } from "./slackCommandAdapter";

import createDebug from "debug";

export const logger = createDebug("nexus:connection:slack");

interface ICommandInfo {
    command: string;
    subCommands: SlackSubCommandList;
}

type CommandMap = Record<string, ICommandInfo>;

export type SlackMessage = {

    [index: string]: any
};

export interface ISlackAckResponse {
    code?: number;
    text?: string;
    body?: Record<string, any>;
    response_action?: string;
    response_type?: string;
    replace_original?: boolean;
    errors?: Record<string, any>;
}

export interface ISlackMessageResponse {
    success: boolean;
    message: string;
    error: Error;
}

export type SlackPayload = {
    [index: string]: any
};

export interface ISlackCommand {
    command: string;
    subCommandListeners: SlackSubCommandList;
    defaultSubCommand?: string;
}

export enum SlackInteractionType {
    action = "action",
    option = "option",
    shortcut = "shortcut",
    viewSubmission = "viewSubmission",
    viewClosed = "viewClosed"
}

export interface ISlackInteractionHandler {
    type: SlackInteractionType;
    matchingConstraints: string | RegExp | ActionConstraints | OptionsConstraints | ViewConstraints;
    handler: SlackInteractionFunction;
}

/**
 * COMMANDS
 */
export type SlackSubCommandFunction = (conn: SlackConnection,
                                       textWithoutAction: string,
                                       slackParams: SlackPayload) => Promise<ISlackAckResponse>;
export type SlackSubCommandList = Record<string, SlackSubCommandFunction>;

/*****
 * EVENTS
 */
export type SlackEventFunction = (conn: SlackConnection, slackParams: SlackPayload) => Promise<ISlackAckResponse>;

export type SlackEventList = Record<string, SlackEventFunction>;

/*****
 * INTERACTION
 */
export type SlackInteractionFunction = (conn: SlackConnection, slackParams: SlackPayload) => Promise<ISlackAckResponse>;

/**
 * These are all the configuration options necessary to integrate your App with slack.  These configuration
 * values are available once you create your app:
 * https://api.slack.com/start/overview#creating
 */
interface ISlackAppConfig {
    appId: string;
    clientId: string;
    clientSecret: string;
    signingSecret: string;
    clientOAuthToken?: string;
    botUserOAuthToken?: string;

    subApp?: Application;
    eventListeners?: SlackEventList;
    interactionListeners?: ISlackInteractionHandler[];

    commands?: ISlackCommand[];

    incomingWebhooks?: string[];
}

export type SlackWebApiResponse = Record<string, any>;

/**
 * The slack connection class implements the base Connection and is the Nexus way to establish a foundational
 * integration.  The Slack Connection specifically offers convenience functions in addition to the base "connect"
 * functionality.
 *
 * In particular, you can use the Slack Connection to integrate your module with the events API and  which is a more
 * complicated integration in that you must validate the signing secret whenever an event is received.  See the
 * documentation for getEventListener.
 */
export class SlackConnection extends Connection {

    public name = "Slack";
    public config: ISlackAppConfig;
    public eventAdapter: SlackEventAdapter;
    public messageAdapter: SlackMessageAdapter;
    public commandsAdapter: SlackCommandAdapter;
    public incomingWebhooks: Record<string, IncomingWebhook>;
    public commands: CommandMap;
    public apiAsApp: WebClient;
    public apiAsBot: WebClient;

    public connect(): SlackConnection {

        this.commands = {};

        // create an api client that uses the *bot* oauth token.  This is required
        // for some endpoints.
        if (!this.apiAsBot && this.config.botUserOAuthToken) {
            this.apiAsBot = new WebClient(this.config.botUserOAuthToken);
        }

        // create an api client that can be used with the "User" OAuth Token -
        // this is confusing in the docs because it often just called the "token"
        if (!this.apiAsApp && this.config.clientOAuthToken) {
            this.apiAsApp = new WebClient(this.config.clientOAuthToken);
        }

        // Setup the event adapter if any event listeners have been given.
        if (!this.eventAdapter && this.config.eventListeners) {
            this.eventAdapter = createEventAdapter(this.config.signingSecret);
            for (const name of Object.keys(this.config.eventListeners)) {
                this.addEvent(name);
            }

            // now register the route with the configured router object.
            this.config.subApp.use("/slack/events", this.eventAdapter.expressMiddleware());
        }

        if (!this.messageAdapter && this.config.interactionListeners) {
            this.messageAdapter = createMessageAdapter(this.config.signingSecret);

            for (const h of this.config.interactionListeners) {
                this.addInteraction(h);
            }

            // now register the route with the configured router object.
            this.config.subApp.use("/slack/interactions", this.messageAdapter.expressMiddleware());
        }

        if (!this.commandsAdapter && this.config.commands) {
            this.commandsAdapter = createCommandAdapter(this.config.signingSecret);

            // now add all the command handlers as given in the config
            for (const cmd of this.config.commands) {
                this.addCommand(this.config.subApp, cmd.command, cmd.subCommandListeners, cmd.defaultSubCommand);
            }
        }

        if (!this.incomingWebhooks && this.config.incomingWebhooks) {
            this.incomingWebhooks = {};
            for (const channel of this.config.incomingWebhooks) {
                this.incomingWebhooks[channel] = new IncomingWebhook(channel);
            }
        }

        return this;
    }

    /**
     * Incoming webhooks are special URLs that have been registered with a slack app that allow you to post
     * to pre-determined channels.
     * @param slackChannel The slackChannel url to poosot to.
     * @param payload The payload that you would pass to the IncomingWebhook.send method.
     */
    public async sendToIncomingWebhook(slackChannel: string, payload: Record<string, any>) {
        if (!this.incomingWebhooks || !(slackChannel in this.incomingWebhooks)) {
            if (!this.incomingWebhooks) {
                this.incomingWebhooks = {};
            }
            this.incomingWebhooks[slackChannel] = new IncomingWebhook((slackChannel));
        }

        try {
            await this.incomingWebhooks[slackChannel].send(payload);
        } catch (e) {
            logger("Slack IncomingWebhook post failed with " + e.message);
        }
    }

    /**
     * Will search a given payload for any items called "text" or "pretext" returning
     * an array of all the text that is part of it.
     * @param payload The payload to search.
     */
    public extractTextFromPayload(payload: SlackPayload): string[] {
        let text: string[] = [];
        Object.keys(payload).forEach((k: string) => {
            if (["pretext", "text"].indexOf(k) > -1) {
                text.push(payload[k]);
            } else if (payload[k] === Object(payload[k])) {
                text = text.concat(this.extractTextFromPayload(payload[k]));
            }
        });

        // remove duplicates.
        return [...new Set(text)];
    }

    /**
     * Gets all messages that are part of the channel thread.  Response documentation available here:
     * https://api.slack.com/methods/channels.replies
     * @param channel The channel the thread took place in
     * @param threadTs The timestamp of the thread.
     */
    public async getChannelThread(channel: string, threadTs: string): Promise<SlackMessage[]> {
        const threadMessages = await this.apiAsApp.conversations.replies({
            ts: threadTs,
            channel,
            limit: 10
        }) as SlackPayload;

        if (threadMessages && threadMessages.ok) {
            return threadMessages.messages;
        } else {
            throw new Error("Unable to get the channel thread.  Failed with this error: " + threadMessages.error);
        }
    }

    /**
     * This will do everything it can to find the thread TS for a given message.  It will first try to find
     * the thread_ts in the given object.  If that's not found but it does find a "ts" and "channel" it will
     * retrieve the full message info from the API and return the thread_ts from that.  If it can't find it there
     * then there was no thread associated with the message or the given object was not a valid message.
     * @param msg The message object to search.
     */
    public async getParentThread(msg: SlackMessage): Promise<string> {
        const threadTs = findProperty(msg, "thread_ts");
        if (threadTs) {
            return threadTs;
        } else {
            const ts = findProperty(msg, "ts");
            const channel = findProperty(msg, "channel");

            if (channel && ts) {
                const fullMessage = await this.getMessageFromChannelAndTs(channel, ts);
                return findProperty(fullMessage, "thread_ts");
            }
        }

        return undefined;
    }

    public async getMessageFromChannelAndTs(channel: string, ts: string): Promise<SlackMessage> {
        // the reaction event doesn't have the message details.
        const history = await this.apiAsApp.conversations.history({
            latest: ts,
            channel,
            limit: 1,
            inclusive: true
        });

        const messages = history ? history.messages as Record<string, any>[] : undefined;

        if (!messages || messages.length === 0) {
            return undefined;
        } else {
            return messages[0];
        }
    }

    /**
     * There are several ways to communicate back to slack when it has sent a command to the server.
     * The first way is to simply send the response to the original request (which is required to come within
     * 3 seconds).  You must handle this yourself as part of creating the command listener (see below).
     *
     * If the work being done will take longer than that, you can instead send a Message
     * response using the "response_url" found in the original request from Slack.  This URL is valid for the next
     * 30 minutes afterwards and can be posted to no more than five times.
     * https://api.slack.com/interactivity/handling#responses
     *
     * This is a thin wrapper around the message response.  Given the original message data, it will confirm
     * that the response URL is there then post to the URL with the given data.
     *
     * @param slackRequestData The data received during the original request
     * @param messageResponseData The data to send with the message response.  This data will be used to construct
     *  a post to the correct channel.
     */
    public async sendMessageResponse(slackRequestData: Record<string, any>, messageResponseData: any): Promise<ISlackMessageResponse> {

        const responseUrl = slackRequestData.response_url;
        if (!responseUrl) {
            throw new Error("The given slack message does not have a response URL");
        }

        return axios.post(responseUrl, messageResponseData)
            .then((_resp: AxiosResponse) => {
                return {
                    success: true,
                    message: `Successfully posted message response`,
                    error: undefined
                };
            })
            .catch((err: AxiosError) => {
                return {
                    success: false,
                    message: `Post to slack for command response failed with error code 
                            ${err.code}: ${err.message}`,
                    error: err
                };
            });
    }

    /**
     * Adds a new command to the list of commands that can be handled by this adapter.  It will
     * use the given router as its base for adding new routes.
     * @param router
     * @param command
     * @param subCommands
     * @param defaultSubCommand
     */
    public addCommand(router: Router, command: string,
                      subCommands: SlackSubCommandList, defaultSubCommand?: string): boolean {

        if (command in this.commands) {
            throw new Error("You cannot add the same command twice to a Command Adapter");
        }

        this.commands[command] = { command, subCommands };

        const subCommandNames = Object.keys(subCommands);
        if (subCommandNames.length === 0) {
            throw new Error("You have to specify at least one sub-command even if there's only one.  It will be " +
                "used as the default sub-command so the user will never have to enter it.");
        }
        if (defaultSubCommand && !(defaultSubCommand in subCommands)) {
            throw new Error("You have specified a default sub-command that is not in the list of sub-commands");
        }

        if (!defaultSubCommand && subCommandNames.length === 1) {
            defaultSubCommand = subCommandNames[0];
        }

        const commandRoute = `/slack/commands/${command}`;

        // install the middleware that will validate incoming slack signatures.
        router.post(commandRoute, this.commandsAdapter.expressMiddleware(), async (req, res) => {
            if (req.body.text === undefined) {
                // this is not a proper slack request so pretend there's nothing here.
                return res.json({
                    code: 400,
                    message: "Invalid slack request"
                });
            }

            const parts = req.body.text.split(" ");
            let actionStr = parts.length === 0 ? "" : parts[0].toLowerCase();
            let textAfterSubCommand = "";
            if (actionStr && !(actionStr in subCommands)) {
                // in this case there's something after the command but it's not one of the subcommands
                //  so treat it as if there's no subcommand..
                actionStr = "";
                textAfterSubCommand = parts.join(" ");
                if (defaultSubCommand) {
                    actionStr = defaultSubCommand;
                }

            } else if (!actionStr) {
                // in this case there's nothing following the command so use the default.
                if (defaultSubCommand) {
                    actionStr = defaultSubCommand;
                }
            } else if (actionStr && (actionStr in subCommands)) {
                // in this case there is a valid subcommand.  So the only
                //  thing we have to do is grab the text  after the subcommand to
                //  pass into the subcommand handler.
                textAfterSubCommand = parts.length > 1 ? parts.slice(1) : "";
            }

            if (!actionStr) {
                return res.json({
                    text: `:x: *You must provide one of the following actions: 
                                ${Object.keys(subCommands).join(",")}*`
                });
            }

            assert(actionStr in subCommands, "Received Slack command event but requested action not defined in module config");
            const actionFunc = subCommands[actionStr];

            // we call the command and exclude the first word in the body of the text (if a command was given).
            // NOTE: This call MUST return within 3 seconds or Slack will assume we're not responding.
            const result = await actionFunc(this, textAfterSubCommand, req.body);

            return res.json(result.body).status(result.code);
        });

        return true;
    }

    public disconnect(): boolean {
        return true;
    }

    private addEvent(name: string) {
        if (!this.eventAdapter) {
            throw new Error("Trying to add an event without calling connect first");
        }

        this.eventAdapter.on(name, (eventPayload) => {
            this.config.eventListeners[name](this, eventPayload);
        });
    }

    private addInteraction(handler: ISlackInteractionHandler) {
        if (!this.messageAdapter) {
            throw new Error("Trying to add an interaction handler without calling connect first");
        }

        if (handler.type === SlackInteractionType.action) {
            this.messageAdapter.action(handler.matchingConstraints, async (payload, _respond) => {
                handler.handler(this, payload).catch((err) => logger("actions handler failed: " + err.toString()));
            });
        } else if (handler.type === SlackInteractionType.option) {
            this.messageAdapter.options(handler.matchingConstraints as OptionsConstraints,
                async (payload) => {
                    handler.handler(this, payload).catch((err) => logger("options handler failed: " + err.toString()));
                });
        } else if (handler.type === SlackInteractionType.shortcut) {
            this.messageAdapter.shortcut(handler.matchingConstraints as OptionsConstraints,
                async (payload) => {
                    handler.handler(this, payload).catch((err) => logger("shortcut handler failed: " + err.toString()));
                });
        } else if (handler.type === SlackInteractionType.viewClosed) {
            this.messageAdapter.viewClosed(handler.matchingConstraints as ViewConstraints,
                async (payload) => {
                    handler.handler(this, payload).catch((err) =>
                        logger("viewClosed handler failed: " + err.toString()));
                });
        } else if (handler.type === SlackInteractionType.viewSubmission) {
            this.messageAdapter.viewSubmission(handler.matchingConstraints as ViewConstraints,
                (payload) => {
                    handler.handler(this, payload)
                        .then((ack) => {
                            logger(ack);
                            return ack;
                        })
                        .catch((err) => logger("viewSubmission handler failed: " + err.toString()));
                });
        }
    }

}

export default function createConnection(cfg: ConnectionConfig, globalCfg: GlobalConfig): Connection {
    return new SlackConnection(cfg, globalCfg);
}
