/*
    Copyright 2021 Rustici Software

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
"use strict";

const Boom = require("@hapi/boom"),
    Wreck = require("@hapi/wreck"),
    Joi = require("joi"),
    { v4: uuidv4 } = require("uuid"),
    Registration = require("../lib/registration");

module.exports = {
    name: "catapult-player-api-routes-v1-registrations",
    register: (server, options) => {
        server.route(
            [
                {
                    method: "POST",
                    path: "/registration",
                    options: {
                        tags: ["api"]
                    },
                    handler: async (req, h) => {
                        const db = req.server.app.db,
                            registrationId = await Registration.create(
                                {
                                    tenantId: req.auth.credentials.tenantId,
                                    courseId: req.payload.courseId,
                                    actor: req.payload.actor
                                },
                                {db}
                            );

                        return db.first("*").from("registrations").where("id", registrationId);
                    }
                },

                {
                    method: "GET",
                    path: "/registration/{id}",
                    options: {
                        tags: ["api"]
                    },
                    handler: async (req, h) => {
                        const result = await Registration.load({tenantId: req.auth.credentials.tenantId, registrationId: req.params.id}, {db: req.server.app.db});

                        if (! result) {
                            return Boom.notFound();
                        }

                        return result;
                    }
                },

                {
                    method: "DELETE",
                    path: "/registration/{id}",
                    options: {
                        tags: ["api"]
                    },
                    handler: async (req, h) => {
                        const tenantId = req.auth.credentials.tenantId,
                            deleteResult = await req.server.app.db("registrations").where({tenantId, "id": req.params.id}).delete();

                        return null;
                    }
                },

                {
                    method: "POST",
                    path: "/registration/{id}/waive-au/{auIndex}",
                    options: {
                        tags: ["api"],
                        payload: {
                            parse: true
                        },
                        validate: {
                            payload: Joi.object({
                                reason: Joi.string().required()
                            }).label("Request-WaiveAU")
                        }
                    },
                    handler: async (req, h) => {
                        // the registrationId could be either the id or the code
                        const registrationId = req.params.id,
                            auIndex = req.params.auIndex,
                            tenantId = req.auth.credentials.tenantId,
                            db = req.server.app.db,
                            lrsWreck = Wreck.defaults(await req.server.methods.lrsWreckDefaults(req)),
                            txn = await db.transaction(),
                            reason = req.payload.reason,
                            sessionCode = uuidv4();
                        let regCourseAu,
                            registration,
                            courseAu;

                        try {
                            ({
                                regCourseAu,
                                registration,
                                courseAu
                            } = await Registration.loadAuForChange(txn, registrationId, auIndex, tenantId));
                        }
                        catch (ex) {
                            txn.rollback();
                            throw Boom.internal(ex);
                        }

                        if (regCourseAu.is_satisfied) {
                            txn.rollback();
                            throw Boom.conflict(new Error("AU is already satsified in registration"));
                        }

                        let stResponse,
                            stResponseBody;

                        try {
                            stResponse = await lrsWreck.request(
                                "POST",
                                "statements",
                                {
                                    headers: {
                                        "Content-Type": "application/json"
                                    },
                                    payload: {
                                        id: uuidv4(),
                                        timestamp: new Date().toISOString(),
                                        actor: registration.actor,
                                        verb: {
                                            id: "https://w3id.org/xapi/adl/verbs/waived",
                                            display: {
                                                en: "waived"
                                            }
                                        },
                                        object: {
                                            id: regCourseAu.courseAu.lms_id
                                        },
                                        result: {
                                            completion: true,
                                            success: true,
                                            extensions: {
                                                "https://w3id.org/xapi/cmi5/result/extensions/reason": reason
                                            }
                                        },
                                        context: {
                                            registration: registration.code,
                                            extensions: {
                                                "https://w3id.org/xapi/cmi5/context/extensions/sessionid": sessionCode
                                            },
                                            contextActivities: {
                                                category: [
                                                    {
                                                        id: "https://w3id.org/xapi/cmi5/context/categories/cmi5"
                                                    },
                                                    {
                                                        id: "https://w3id.org/xapi/cmi5/context/categories/moveon"
                                                    }
                                                ]
                                            }
                                        }
                                    }
                                }
                            );

                            stResponseBody = await Wreck.read(stResponse, {json: true});
                        }
                        catch (ex) {
                            txn.rollback();
                            throw Boom.internal(new Error(`Failed request to store waived statement: ${ex}`));
                        }

                        if (stResponse.statusCode !== 200) {
                            txn.rollback();
                            throw Boom.internal(new Error(`Failed to store waived statement (${stResponse.statusCode}): ${stResponseBody}`));
                        }

                        try {
                            await txn("registrations_courses_aus").update(
                                {
                                    is_waived: true,
                                    waived_reason: reason,
                                    is_satisfied: true
                                }
                            ).where({id: regCourseAu.id, tenantId});
                        }
                        catch (ex) {
                            txn.rollback();
                            throw Boom.internal(`Failed to update registrations_courses_aus: ${ex}`);
                        }

                        try {
                            await Registration.interpretMoveOn(
                                registration,
                                {
                                    auToSetSatisfied: regCourseAu.courseAu.lms_id,
                                    sessionCode,
                                    lrsWreck: Wreck.defaults(await req.server.methods.lrsWreckDefaults(req))
                                }
                            );
                        }
                        catch (ex) {
                            throw new Error(`Failed to interpret moveOn: ${ex}`);
                        }

                        try {
                            await txn("registrations").update({metadata: JSON.stringify(registration.metadata)}).where({id: registration.id});
                        }
                        catch (ex) {
                            throw new Error(`Failed to update registration metadata: ${ex}`);
                        }

                        txn.commit();

                        return null;
                    }
                }
            ]
        );
    }
};
