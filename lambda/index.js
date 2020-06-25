const winston = require('winston');
const AWS = require('aws-sdk');
const fetch = require('node-fetch');
const uuid = require('uuid');

const s3 = new AWS.S3();
const LOG = winston.createLogger({
    level: "debug",
    transports: [
        new winston.transports.Console()
    ]
});

function getCellsForGoogleAnalytics(s3data) {
    let cells = [];
    let row = 0;
    let column = -1;

    cells = cells.concat(s3data['reports'][0]['columnHeader']['dimensions'].concat(s3data['reports'][0]['columnHeader']['metricHeader']['metricHeaderEntries'].map(value => {
        return value.name;
    })).map(value => {
        column += 1;
        return {
            "address": {
                "column": column,
                "row": row
            },
            "formula": value
        }
    }));

    for (let rowdata of s3data['reports'][0]['data']['rows']) {
        row += 1;
        column = -1;
        
        cells = cells.concat(rowdata['dimensions'].concat(rowdata['metrics'].map(value => {
            return value.values.join(",")
        })).map(value => {
            column += 1;
            return {
                "address": {
                    "column": column,
                    "row": row
                },
                "formula": value
            }
        }));
    }

    return cells;
}

exports.handler = async (event, context) => {
    LOG.debug(event);

    for (let record of event['Records']) {
        const s3obj = await s3.getObject({
            Bucket: record['s3']['bucket']['name'],
            Key: record['s3']['object']['key']
        }).promise();
        
        const s3data = JSON.parse(s3obj.Body.toString('utf-8'));
        
        const loginReq = await fetch("https://bhauthngateway.us-east-1.honeycode.aws/v2/login", {
            "headers": {
                "accept": "application/json, text/plain, */*",
                "content-type": "application/json;charset=UTF-8",
                "origin": "https://builder.honeycode.aws"
            },
            "body": JSON.stringify({
                "emailAddress": process.env.EMAIL_ADDRESS,
                "password": process.env.PASSWORD
            }),
            "method": "POST",
            "mode": "cors"
        });
        
        let apitoken = '';
        for (let cookie of loginReq.headers.raw()['set-cookie']) {
            if (cookie.startsWith("bluesky-api-token=")) {
                apitoken = cookie.split("=")[1].split(";")[0];
            }
        }

        const templateReq = await fetch("https://control.us-west-2.honeycode.aws/templatelist-prod.txt", {
            "headers": {
                "accept": "*/*",
                "cookie": "bluesky-api-token=" + apitoken,
                "origin": "https://builder.honeycode.aws"
            },
            "method": "GET",
            "mode": "cors",
            "credentials": "include"
        });
        const templateData = await templateReq.json();
        const sheetsRegion = templateData['templates'][0]['arn'].split(":")[3];
        const sheetsAccount = templateData['templates'][0]['arn'].split(":")[4];

        const workbookReq = await fetch("https://control.us-west-2.honeycode.aws/", {
            "headers": {
                "accept": "*/*",
                "content-encoding": "amz-1.0",
                "content-type": "application/json",
                "x-amz-target": "com.amazon.sheets.control.api.SheetsControlServiceAPI_20170701.DescribeWorkbook",
                "x-client-id": "clientRegion|BeehiveSDSJSUtils||||",
                "cookie": "bluesky-api-token=" + apitoken,
                "origin": "https://builder.honeycode.aws"
            },
            "body": JSON.stringify({
                "workbook": "arn:aws:sheets:" + sheetsRegion + ":" + sheetsAccount + ":workbook:" + process.env.WORKBOOK
            }),
            "method": "POST",
            "mode": "cors",
            "credentials": "include"
        });
        const workbookData = await workbookReq.json();

        LOG.info("Updating data in arn:aws:sheets:" + sheetsRegion + ":" + sheetsAccount + ":sheet:" + process.env.WORKBOOK + "/" + process.env.SHEET);

        const updateReq = await fetch("https://" + workbookData['workbook']['endpoint'] + "/external/", {
            "headers": {
                "accept": "application/json, text/javascript, */*",
                "content-encoding": "amz-1.0, amz-1.0",
                "content-type": "application/json",
                "x-amz-target": "com.amazon.sheets.data.external.SheetsDataService.BatchUpdateCell",
                "x-client-id": "prod|Sheets||||",
                "cookie": "bluesky-api-token=" + apitoken,
                "origin": "https://builder.honeycode.aws"
            },
            "body": JSON.stringify({
                "eventType": "BatchUpdateCell",
                "sheetArn": "arn:aws:sheets:" + sheetsRegion + ":" + sheetsAccount + ":sheet:" + process.env.WORKBOOK + "/" + process.env.SHEET,
                "clientToken": uuid.v4(),
                "cells": getCellsForGoogleAnalytics(s3data)
            }),
            "method": "POST",
            "mode": "cors",
            "credentials": "include"
        });
        const updateData = await updateReq.json();

        LOG.debug(updateData);
    }
};
