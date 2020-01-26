import express from "express";
import * as querystring from "querystring";
import {verifyRequestSignature} from "@slack/events-api/dist";
import {ErrorCode, ResponseError, ResponseHandler} from "@slack/events-api/dist/http-handler";
import {IncomingMessage, ServerResponse} from "http";
import getRawBody from "raw-body";
import {CodedError, errorWithCode} from "@slack/interactive-messages/dist/errors";
import {logger} from ".";

/**
 * The SlackCommandAdapter is a class that mimics the functionality in the SlackEventAdapater
 * and SlackInteractionAdapter.  It does the work of injecting middleware which properly responds to Slack
 * challenges and does signature validation.  It does not do any of the node event emitting done by the built-in
 * adapters because events are hard to follow and, here, unnecessary.
 *
 * For more about slack commands, visit this doc:
 * https://api.slack.com/interactivity/slash-commands
 */
export class SlackCommandAdapter {

    protected signingSecret: string;

    public constructor(signingSecret: string) {
        this.signingSecret = signingSecret;
    }

    public expressMiddleware() {

        const signingSecret = this.signingSecret;

        /**
         * Request listener used to handle Slack requests and send responses and
         * verify request signatures
         *
         * @param req - The incoming request.
         * @param res - The outgoing response.
         */
        return (req: IncomingMessage, res: ServerResponse, next: express.NextFunction) => {

            const respond = getResponder(res);

            // If parser is being used and we don't receive the raw payload via `rawBody`,
            // we can't verify request signature
            // @ts-ignore
            if (!isFalsy(req.body) && isFalsy(req.rawBody)) {
                throw errorWithCode(
                    new Error("Parsing request body prohibits request signature verification"),
                    ErrorCode.BodyParserNotPermitted,
                );
            }

            getRawBody(req)
                .then((bodyBuf) => {
                    const rawBody = bodyBuf.toString();
                    if (verifyRequestSignature({
                        signingSecret,
                        requestSignature: req.headers["x-slack-signature"] as string,
                        requestTimestamp: parseInt(req.headers["x-slack-request-timestamp"] as string, 10),
                        body: rawBody,
                    })) {
                        // Request signature is verified
                        // Parse raw body
                        // @ts-ignore
                        req.body = parseBody(rawBody);

                        // Handle URL verification challenge
                        // @ts-ignore
                        if (req.body.type === "url_verification") {
                            logger("handling url verification");
                            // @ts-ignore
                            respond(undefined, {content: req.body.challenge});
                            return;
                        }

                        next();

                    }
                }).catch((error) => {
                handleError(error, respond);
            });
        };
    }
}

/**
 * Creates a responder based on a response object that is provided.  It returns a function that  can be called
 * to send a response after a request has been made.
 * @param res The response to use as a destination.
 */
function getResponder(res: ServerResponse): ResponseHandler {
    // This function is the completion handler for sending a response to an event. It can either
    // be invoked by automatically or by the user (when using the `waitForResponse` option).
    return (err, responseOptions) => {
        logger("sending response - error: %s, responseOptions: %o", err, responseOptions);
        // Deal with errors up front
        if (!isFalsy(err)) {
            if ("status" in err && typeof err.status === "number") {
                res.statusCode = err.status;
            } else if (
                (err as CodedError).code === ErrorCode.SignatureVerificationFailure ||
                (err as CodedError).code === ErrorCode.RequestTimeFailure
            ) {
                res.statusCode = 404;
            } else {
                res.statusCode = 500;
            }
        } else {
            // First determine the response status
            if (!isFalsy(responseOptions)) {
                if (responseOptions.failWithNoRetry) {
                    res.statusCode = 500;
                } else if (responseOptions.redirectLocation) {
                    res.statusCode = 301;
                } else {
                    // URL Verification
                    res.statusCode = 200;
                }
            } else {
                res.statusCode = 200;
            }

            // Next determine the response headers
            if (!isFalsy(responseOptions) && responseOptions.failWithNoRetry) {
                res.setHeader("X-Slack-No-Retry", "1");
            }
            res.setHeader("X-Slack-Powered-By", "ua-nexus");
        }

        // Lastly, send the response
        if (!isFalsy(responseOptions) && responseOptions.content) {
            res.end(responseOptions.content);
        } else {
            res.end();
        }
    };
}

/**
 * Handles making responses for errors.
 *
 * @param error - The error that occurred.
 * @param respond - The {@link ResponseHandler | response handler}.
 */
function handleError(error: CodedError, respond: ResponseHandler): void {
    logger("handling error - message: %s, code: %s", error.message, error.code);
    try {
        if (process.env.NODE_ENV === "development") {
            respond({status: 500} as ResponseError, {content: error.message});
        } else {
            respond(error);
        }
    } catch (userError) {
        process.nextTick(() => {
            throw userError;
        });
    }
}

/**
 * Parses raw bodies of requests
 *
 * @param body - Raw body of request
 * @returns Parsed body of the request
 */
function parseBody(body: string): any {
    const parsedBody = querystring.parse(body);
    if (!isFalsy(parsedBody.payload)) {
        // Parse as JSON if it's not a url-encoded body.
        return JSON.parse(parsedBody.payload as string);
    }

    return parsedBody;
}

/**
 * Tests a "thing" for being falsy. See: https://developer.mozilla.org/en-US/docs/Glossary/Falsy
 *
 * @param x - The "thing" whose falsy-ness to test.
 */
function isFalsy(x: any): x is 0 | "" | null | undefined {
    // NOTE: there's no way to type `x is NaN` currently (as of TypeScript v3.5)
    return x === 0 || x === "" || x === null || x === undefined || (typeof x === "number" && isNaN(x));
}

export const createCommandAdapter = (signingSecret: string): SlackCommandAdapter => {
    return new SlackCommandAdapter(signingSecret);
};
