/*
 * Instagram publishing helpers.
 *
 * This project uses the Instagram API with Instagram Login.
 * The access token belongs to the Instagram professional account.
 */

const DEFAULT_API_VERSION = 'v26.0';
const GRAPH_HOST = 'https://graph.instagram.com';

const MAX_PUBLISH_POLL_ATTEMPTS = 12;
const PUBLISH_POLL_DELAY_MS = 1500;

function getInstagramConfig() {
  const accessToken =
    process.env.INSTAGRAM_ACCESS_TOKEN?.trim();

  const accountId =
    process.env.INSTAGRAM_ACCOUNT_ID?.trim();

  const apiVersion =
    normalizeApiVersion(
      process.env.INSTAGRAM_API_VERSION
    );

  const defaultCaption =
    process.env.INSTAGRAM_DEFAULT_CAPTION?.trim() || '';

  if (!accessToken) {
    throw new Error(
      'INSTAGRAM_ACCESS_TOKEN is not configured.'
    );
  }

  if (!accountId) {
    throw new Error(
      'INSTAGRAM_ACCOUNT_ID is not configured.'
    );
  }

  return {
    accessToken,
    accountId,
    apiVersion,
    defaultCaption,
  };
}

function normalizeApiVersion(value) {
  const cleanedValue =
    value?.trim();

  if (!cleanedValue) {
    return DEFAULT_API_VERSION;
  }

  return cleanedValue.startsWith('v')
    ? cleanedValue
    : `v${cleanedValue}`;
}

function buildUrl(
  path,
  apiVersion
) {
  return (
    `${GRAPH_HOST}/${apiVersion}/${path}`
  );
}

async function instagramRequest(
  path,
  method,
  params = {}
) {
  const {
    accessToken,
    apiVersion,
  } = getInstagramConfig();

  const url =
    buildUrl(
      path,
      apiVersion
    );

  let response;

  if (method === 'GET') {
    const searchParams =
      new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (
        value !== undefined &&
        value !== null
      ) {
        searchParams.set(
          key,
          String(value)
        );
      }
    }

    const query =
      searchParams.toString();

    response =
      await fetch(
        query
          ? `${url}?${query}`
          : url,
        {
          method: 'GET',

          headers: {
            Authorization:
              `Bearer ${accessToken}`,
          },
        }
      );
  } else {
    const form =
      new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (
        value !== undefined &&
        value !== null
      ) {
        form.set(
          key,
          String(value)
        );
      }
    }

    response =
      await fetch(
        url,
        {
          method,

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            'Content-Type':
              'application/x-www-form-urlencoded',
          },

          body:
            form.toString(),
        }
      );
  }

  const responseText =
    await response.text();

  let responseData = null;

  try {
    responseData =
      responseText
        ? JSON.parse(responseText)
        : null;
  } catch (error) {
    responseData = null;
  }

  if (!response.ok) {
    throw createInstagramError(
      response.status,
      responseData,
      responseText
    );
  }

  return responseData || {};
}

function createInstagramError(
  httpStatus,
  responseData,
  responseText
) {
  const graphError =
    responseData?.error;

  const message =
    graphError?.message ||
    responseData?.message ||
    responseText ||
    'Unknown Instagram API error.';

  const error =
    new Error(
      `Instagram API error (${httpStatus}): ${message}`
    );

  error.httpStatus =
    httpStatus;

  error.instagramCode =
    graphError?.code;

  error.instagramSubcode =
    graphError?.error_subcode;

  error.instagramType =
    graphError?.type;

  return error;
}


/* ============================================================
   PUBLIC PUBLISHING API
   ============================================================ */

/*
 * Publishes one or more staged image posts.
 *
 * 1 image:
 *   - single IMAGE container
 *   - wait for it to finish
 *   - publish it
 *
 * 2-10 images:
 *   - create one CAROUSEL_ITEM container per image
 *   - wait for all child containers
 *   - create a CAROUSEL container
 *   - wait for the carousel container
 *   - publish it
 */
export async function publishInstagramPosts(
  posts
) {
  if (
    !Array.isArray(posts) ||
    posts.length < 1 ||
    posts.length > 10
  ) {
    throw new Error(
      'Instagram publishing requires between 1 and 10 staged posts.'
    );
  }

  validatePosts(posts);

  if (posts.length === 1) {
    return publishSingleImage(
      posts[0]
    );
  }

  return publishCarousel(
    posts
  );
}


/* ============================================================
   SINGLE IMAGE
   ============================================================ */

async function publishSingleImage(post) {
  const {
    accountId,
    defaultCaption,
  } = getInstagramConfig();

  const containerParams = {
    image_url:
      post.imageUrl,
  };

  if (defaultCaption) {
    containerParams.caption =
      defaultCaption;
  }

  const container =
    await instagramRequest(
      `${accountId}/media`,
      'POST',
      containerParams
    );

  const containerId =
    requireContainerId(
      container
    );

  await waitForContainer(
    containerId
  );

  const published =
    await publishContainer(
      containerId
    );

  return {
    ...published,
    type: 'single',
    count: 1,
  };
}


/* ============================================================
   CAROUSEL
   ============================================================ */

async function publishCarousel(posts) {
  const childContainers =
    await Promise.all(
      posts.map(
        (post) =>
          createCarouselItem(
            post
          )
      )
    );

  await Promise.all(
    childContainers.map(
      (containerId) =>
        waitForContainer(
          containerId
        )
    )
  );

  const {
    accountId,
    defaultCaption,
  } = getInstagramConfig();

  const carouselParams = {
    media_type:
      'CAROUSEL',

    children:
      childContainers.join(','),
  };

  if (defaultCaption) {
    carouselParams.caption =
      defaultCaption;
  }

  const carousel =
    await instagramRequest(
      `${accountId}/media`,
      'POST',
      carouselParams
    );

  const carouselId =
    requireContainerId(
      carousel
    );

  await waitForContainer(
    carouselId
  );

  const published =
    await publishContainer(
      carouselId
    );

  return {
    ...published,
    type: 'carousel',
    count: posts.length,
  };
}

async function createCarouselItem(post) {
  const {
    accountId,
  } = getInstagramConfig();

  const response =
    await instagramRequest(
      `${accountId}/media`,
      'POST',
      {
        image_url:
          post.imageUrl,

        is_carousel_item:
          true,
      }
    );

  return requireContainerId(
    response
  );
}


/* ============================================================
   CONTAINER STATUS / PUBLISH
   ============================================================ */

async function waitForContainer(
  containerId
) {
  let lastStatus = null;

  for (
    let attempt = 0;
    attempt <
      MAX_PUBLISH_POLL_ATTEMPTS;
    attempt += 1
  ) {
    const status =
      await getContainerStatus(
        containerId
      );

    lastStatus =
      status.statusCode;

    if (
      status.statusCode ===
      'FINISHED'
    ) {
      return status;
    }

    if (
      status.statusCode ===
        'ERROR' ||
      status.statusCode ===
        'EXPIRED'
    ) {
      throw new Error(
        `Instagram container ${containerId} failed with status ` +
          `${status.statusCode}: ` +
          `${status.status || 'No status message supplied.'}`
      );
    }

    /*
     * PUBLISHED is included as a safe terminal state in case
     * a retry reaches a container that has already been published.
     */
    if (
      status.statusCode ===
      'PUBLISHED'
    ) {
      return status;
    }

    if (
      attempt <
      MAX_PUBLISH_POLL_ATTEMPTS - 1
    ) {
      await delay(
        PUBLISH_POLL_DELAY_MS
      );
    }
  }

  throw new Error(
    `Instagram container ${containerId} did not finish processing ` +
      `within the allowed time. Last status: ${lastStatus || 'unknown'}.`
  );
}

async function getContainerStatus(
  containerId
) {
  const response =
    await instagramRequest(
      containerId,
      'GET',
      {
        fields:
          'status_code,status',
      }
    );

  return {
    statusCode:
      response.status_code,

    status:
      response.status,
  };
}

async function publishContainer(
  containerId
) {
  const {
    accountId,
  } = getInstagramConfig();

  const response =
    await instagramRequest(
      `${accountId}/media_publish`,
      'POST',
      {
        creation_id:
          containerId,
      }
    );

  const mediaId =
    response.id;

  if (!mediaId) {
    throw new Error(
      'Instagram accepted the publish request but returned no media ID.'
    );
  }

  return {
    mediaId,
    containerId,
  };
}


/* ============================================================
   VALIDATION / HELPERS
   ============================================================ */

function validatePosts(posts) {
  for (
    const [index, post] of posts.entries()
  ) {
    if (
      !post ||
      typeof post !== 'object'
    ) {
      throw new Error(
        `Staged post ${index + 1} is invalid.`
      );
    }

    if (
      typeof post.imageUrl !==
        'string' ||
      post.imageUrl.trim() === ''
    ) {
      throw new Error(
        `Staged post ${index + 1} does not contain a valid image URL.`
      );
    }

    if (
      !/^https:\/\//i.test(
        post.imageUrl
      )
    ) {
      throw new Error(
        `Staged post ${index + 1} does not use an HTTPS image URL.`
      );
    }
  }
}

function requireContainerId(response) {
  if (!response?.id) {
    throw new Error(
      'Instagram created a media container but returned no container ID.'
    );
  }

  return response.id;
}

function delay(milliseconds) {
  return new Promise(
    (resolve) => {
      setTimeout(
        resolve,
        milliseconds
      );
    }
  );
}
