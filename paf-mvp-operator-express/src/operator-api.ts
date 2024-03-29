import {Express, Request, Response} from "express";
import {getPafDataFromQueryString, httpRedirect, removeCookie, setCookie} from "@core/express";
import cors, {CorsOptions} from "cors";
import {v4 as uuidv4} from "uuid";
import {
    GetIdsPrefsRequest,
    Identifier,
    PostIdsPrefsRequest,
    RedirectGetIdsPrefsRequest,
    RedirectPostIdsPrefsRequest,
    Test3Pc
} from "@core/model/generated-model";
import {UnsignedData} from "@core/model/model";
import {getTimeStampInSec} from "@core/timestamp";
import {GetIdsPrefsRequestSigner, PostIdsPrefsRequestSigner} from "@core/crypto/message-signature";
import {
    Cookies,
    fromIdsCookie,
    fromPrefsCookie,
    fromTest3pcCookie,
    toTest3pcCookie
} from "@core/cookies";
import {IdSigner} from "@core/crypto/data-signature";
import {PrivateKey, privateKeyFromString, PublicKeys} from "@core/crypto/keys";
import {jsonEndpoints, redirectEndpoints} from "@core/endpoints";
import {
    Get3PCResponseBuilder,
    GetIdsPrefsResponseBuilder,
    PostIdsPrefsResponseBuilder
} from "@core/model/response-builders";

const domainParser = require('tld-extract');

// Expiration: now + 3 months
const getOperatorExpiration = (date: Date = new Date()) => {
    const expirationDate = new Date(date);
    expirationDate.setMonth(expirationDate.getMonth() + 3);
    return expirationDate;
}

// TODO should be a proper ExpressJS middleware
// TODO all received requests should be verified (signature)
export const addOperatorApi = (app: Express, operatorHost: string, privateKey: string, publicKeyStore: PublicKeys) => {

    const getIdsPrefsResponseBuilder = new GetIdsPrefsResponseBuilder(operatorHost, privateKey)
    const get3PCResponseBuilder = new Get3PCResponseBuilder(operatorHost, privateKey)
    const postIdsPrefsResponseBuilder = new PostIdsPrefsResponseBuilder(operatorHost, privateKey)

    const tld = domainParser(`https://${operatorHost}`).domain

    const writeAsCookies = (input: PostIdsPrefsRequest, res: Response) => {
        // FIXME here we should verify signatures
        if (input.body.identifiers !== undefined) {
            setCookie(res, Cookies.identifiers, JSON.stringify(input.body.identifiers), getOperatorExpiration(), {domain: tld})
        }
        if (input.body.preferences !== undefined) {
            setCookie(res, Cookies.preferences, JSON.stringify(input.body.preferences), getOperatorExpiration(), {domain: tld})
        }
    };

    const operatorApi = new OperatorApi(operatorHost, privateKey)

    const getReadResponse = (request: GetIdsPrefsRequest, req: Request) => {
        if (!operatorApi.getIdsPrefsRequestVerifier.verify(publicKeyStore[request.sender], request)) {
            throw 'Read request verification failed'
        }

        const identifiers = fromIdsCookie(req.cookies[Cookies.identifiers]) ?? []
        const preferences = fromPrefsCookie(req.cookies[Cookies.preferences])

        if (!identifiers.some((i: Identifier) => i.type === 'paf_browser_id')) {
            // No existing id, let's generate one, unpersisted
            identifiers.push(operatorApi.generateNewId())
        }

        return getIdsPrefsResponseBuilder.buildResponse(
            request.sender,
            {identifiers, preferences}
        );
    };

    const getWriteResponse = (input: PostIdsPrefsRequest, res: Response) => {
        if (!operatorApi.postIdsPrefsRequestVerifier.verify(publicKeyStore[input.sender], input)) {
            throw 'Write request verification failed'
        }

        // because default value is true, we just remove it to save space
        input.body.identifiers[0].persisted = undefined;

        writeAsCookies(input, res);

        const {identifiers, preferences} = input.body

        return postIdsPrefsResponseBuilder.buildResponse(input.sender, {identifiers, preferences});
    };

    // *****************************************************************************************************************
    // ************************************************************************************************************ JSON
    // *****************************************************************************************************************

    // Note that CORS is "disabled" here because the check is done via signature
    // So accept whatever the referer is
    const corsOptions = (req: Request, callback: (err: Error | null, options?: CorsOptions) => void) => {
        callback(null, {
            origin: req.header('Origin'),
            optionsSuccessStatus: 200, // some legacy browsers (IE11, various SmartTVs) choke on 204
            credentials: true
        });
    };

    const setTest3pcCookie = (res: Response) => {
        const now = new Date();
        const expirationDate = new Date(now)
        expirationDate.setTime(now.getTime() + 1000 * 60) // Lifespan: 1 minute
        const test3pc: Test3Pc = {
            timestamp: getTimeStampInSec(now)
        }
        setCookie(res, Cookies.test_3pc, toTest3pcCookie(test3pc), expirationDate, {domain: tld})
    }

    app.get(jsonEndpoints.read, cors(corsOptions), (req, res) => {
        // Attempt to set a cookie (as 3PC), will be useful later if this call fails to get Prebid cookie values
        setTest3pcCookie(res);

        const request = getPafDataFromQueryString<GetIdsPrefsRequest>(req)

        const response = getReadResponse(request, req);

        res.send(response)
    });

    app.get(jsonEndpoints.verify3PC, cors(corsOptions), (req, res) => {
        // Note: no signature verification here

        const cookies = req.cookies;
        const testCookieValue = fromTest3pcCookie(cookies[Cookies.test_3pc])

        // Clean up
        removeCookie(req, res, Cookies.test_3pc, {domain: tld})

        const response = get3PCResponseBuilder.buildResponse(testCookieValue);

        // TODO could do some check on timestamp value
        if (testCookieValue === undefined) {
            res.status(404)
        }

        res.send(response)
    });

    app.post(jsonEndpoints.write, cors(corsOptions), (req, res) => {
        const input = JSON.parse(req.body as string) as PostIdsPrefsRequest;

        try {
            const signedData = getWriteResponse(input, res);

            res.send(signedData)
        } catch (e) {
            res.sendStatus(400)
            res.send(e)
        }
    });

    // *****************************************************************************************************************
    // ******************************************************************************************************* REDIRECTS
    // *****************************************************************************************************************

    app.get(redirectEndpoints.read, (req, res) => {
        const {request, returnUrl} = getPafDataFromQueryString<RedirectGetIdsPrefsRequest>(req)

        if (returnUrl) {

            const response = getReadResponse(request, req);

            const redirectResponse = getIdsPrefsResponseBuilder.toRedirectResponse(response, 200)
            const redirectUrl = getIdsPrefsResponseBuilder.getRedirectUrl(new URL(returnUrl), redirectResponse);

            httpRedirect(res, redirectUrl.toString());
        } else {
            res.sendStatus(400)
        }
    });

    app.get(redirectEndpoints.write, (req, res) => {
        const {request, returnUrl} = getPafDataFromQueryString<RedirectPostIdsPrefsRequest>(req)

        if (returnUrl) {
            const response = getWriteResponse(request, res);

            const redirectResponse = postIdsPrefsResponseBuilder.toRedirectResponse(response, 200)
            const redirectUrl = postIdsPrefsResponseBuilder.getRedirectUrl(new URL(returnUrl), redirectResponse);

            httpRedirect(res, redirectUrl.toString());
        } else {
            res.sendStatus(400)
        }
    });
}

// FIXME should probably be moved to core library
export class OperatorApi {
    private readonly idSigner = new IdSigner()
    private readonly ecdsaKey: PrivateKey

    readonly getIdsPrefsRequestVerifier = new GetIdsPrefsRequestSigner();
    readonly postIdsPrefsRequestVerifier = new PostIdsPrefsRequestSigner();

    constructor(public host: string, privateKey: string) {
        this.ecdsaKey = privateKeyFromString(privateKey)
    }

    generateNewId(timestamp = new Date().getTime()): Identifier {
        return {
            ...this.signId(uuidv4(), timestamp),
            persisted: false
        };
    }

    signId(value: string, timestampInSec = getTimeStampInSec()): Identifier {
        const unsignedId: UnsignedData<Identifier> = {
            version: "0.1",
            type: 'paf_browser_id',
            value,
            source: {
                domain: this.host,
                timestamp: timestampInSec
            }
        };
        const {source, ...rest} = unsignedId

        return {
            ...rest,
            source: {
                ...source,
                signature: this.idSigner.sign(this.ecdsaKey, unsignedId)
            }
        };
    }
}
