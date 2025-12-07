export async function onRequest(context) {
    const {
        request,
        env,
        params,
    } = context;

    const url = new URL(request.url);
    let fileUrl = 'https://telegra.ph/' + url.pathname + url.search;

    // 如果是 Bot API 上传的文件（路径特别长）
    if (url.pathname.length > 39) {
        const fileId = url.pathname.split(".")[0].split("/")[2];
        const filePath = await getFilePath(env, fileId);

        if (filePath) {
            fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
        }
    }

    const response = await fetch(fileUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
    });

    if (!response.ok) return fixImageResponse(response);

    // admin 页面允许直接显示原图
    const isAdmin = request.headers.get('Referer')?.includes(`${url.origin}/admin`);
    if (isAdmin) {
        return fixImageResponse(response);
    }

    // 如果没 KV，直接返回图片
    if (!env.img_url) {
        return fixImageResponse(response);
    }

    // 从 KV 获取 metadata
    let record = await env.img_url.getWithMetadata(params.id);
    if (!record || !record.metadata) {
        record = {
            metadata: {
                ListType: "None",
                Label: "None",
                TimeStamp: Date.now(),
                liked: false,
                fileName: params.id,
                fileSize: 0,
            }
        };
        await env.img_url.put(params.id, "", { metadata: record.metadata });
    }

    const metadata = {
        ListType: record.metadata.ListType || "None",
        Label: record.metadata.Label || "None",
        TimeStamp: record.metadata.TimeStamp || Date.now(),
        liked: record.metadata.liked !== undefined ? record.metadata.liked : false,
        fileName: record.metadata.fileName || params.id,
        fileSize: record.metadata.fileSize || 0,
    };

    // 白名单：直接显示
    if (metadata.ListType === "White") {
        return fixImageResponse(response);
    }

    // 黑名单 / 成人内容 → 拦截
    if (metadata.ListType === "Block" || metadata.Label === "adult") {
        const referer = request.headers.get('Referer');
        const redirectUrl = referer
            ? "https://static-res.pages.dev/teleimage/img-block-compressed.png"
            : `${url.origin}/block-img.html`;

        return Response.redirect(redirectUrl, 302);
    }

    // 如果开启白名单模式，则不允许公开访问
    if (env.WhiteList_Mode === "true") {
        return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
    }

    // 内容审核
    if (env.ModerateContentApiKey) {
        try {
            const moderateUrl = `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&url=https://telegra.ph${url.pathname}${url.search}`;
            const moderateResponse = await fetch(moderateUrl);

            if (moderateResponse.ok) {
                const moderateData = await moderateResponse.json();

                if (moderateData && moderateData.rating_label) {
                    metadata.Label = moderateData.rating_label;

                    if (moderateData.rating_label === "adult") {
                        await env.img_url.put(params.id, "", { metadata });
                        return Response.redirect(`${url.origin}/block-img.html`, 302);
                    }
                }
            }
        } catch (error) {
            console.error("Moderation error:", error.message);
        }
    }

    // 保存 metadata
    await env.img_url.put(params.id, "", { metadata });

    // 返回图片（强制 inline）
    return fixImageResponse(response);
}


// -------------------------
// 强制图片直接显示，而不是下载
// -------------------------
function fixImageResponse(originalResponse) {
    const newHeaders = new Headers(originalResponse.headers);

    // 强制 inline 展示
    newHeaders.set("Content-Disposition", "inline");

    // 修复错误 Content-Type（telegram 有时返回 octet-stream）
    const rawType = originalResponse.headers.get("Content-Type");
    if (!rawType || !rawType.startsWith("image/")) {
        newHeaders.set("Content-Type", "image/jpeg");
    }

    return new Response(originalResponse.body, {
        status: originalResponse.status,
        headers: newHeaders
    });
}


// -------------------------
// 通过 Telegram Bot 获取文件路径
// -------------------------
async function getFilePath(env, file_id) {
    try {
        const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${file_id}`;
        const res = await fetch(url, { method: 'GET' });

        if (!res.ok) return null;

        const data = await res.json();
        if (data.ok && data.result) return data.result.file_path;

        return null;
    } catch (error) {
        console.error("Error fetching file path:", error.message);
        return null;
    }
}
